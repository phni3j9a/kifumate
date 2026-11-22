import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import worker, { type Env } from '../src/index';
import { sha256 } from '../src/model';

it('Worker→DOのヘッダー・本文へsecretや外部の内部ヘッダーを転送しない', async () => {
  const token = 'a'.repeat(64), hash = await sha256(token), ip = await sha256('192.0.2.10');
  const secrets = {COACH_API_KEY: 'secret-provider-value', COACH_SIGNING_KEY: 'secret-signing-value',
    INVITE_ADMIN_KEY: 'secret-admin-value', DEV_PAID_HASHES: 'secret-other-device,' + hash};
  for (const [path, body] of [['/v1/coach', {requestId: 'test'}], ['/v1/jobs', {initial: 'startpos'}],
    ['/v1/realtime', {initial: 'startpos'}], ['/v1/invitations/redeem', {code: 'test'}], ['/v1/entitlements', undefined]] as const) {
    let captured: Request | undefined;
    const bindings = {...env, ...secrets, ENVIRONMENT: 'staging', ALLOW_DEV_PAID: 'true',
      DEVICES: {getByName: (name: string) => ({fetch: async (request: Request) => {
        expect(name).toBe(hash); captured = request.clone(); return Response.json({ok: true});
      }})},
    } as unknown as Env;
    const response = await worker.fetch(new Request('https://api' + path, {method: body ? 'POST' : 'GET', headers: {
      Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'respond-async',
      'CF-Connecting-IP': '192.0.2.10', 'X-Coach-Config': JSON.stringify(secrets), 'X-Dev-Paid': 'forged',
      'X-Device-Hash': 'forged', 'X-Invite-IP': 'forged', 'X-Dev-Entitlement': '1', 'X-Realtime-Owner': 'forged',
      'X-Unrelated': secrets.INVITE_ADMIN_KEY,
    }, ...(body ? {body: JSON.stringify(body)} : {})}), bindings);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(captured!.headers)).toEqual({'content-type': 'application/json', prefer: 'respond-async', 'x-dev-paid': '1', 'x-invite-ip': ip});
    const forwardedBody = await captured!.text();
    expect(forwardedBody).toBe(body ? JSON.stringify(body) : '');
    const forwarded = JSON.stringify([...captured!.headers]) + forwardedBody;
    for (const value of [...Object.values(secrets), token]) expect(forwarded).not.toContain(value);
  }
});

it('drain中はコーチを含む新規・局面更新だけを入口で止め、照会と中止は転送する', async () => {
  const bindings = {...env, ANALYSIS_DRAIN: 'true', DEVICES: {getByName: () => ({fetch: () => Response.json({ok: true})})}} as unknown as Env;
  for (const [method, path, status] of [['POST','jobs',503], ['POST','coach',503], ['POST','realtime',503],
    ['PUT',`realtime/${crypto.randomUUID()}`,503], ['DELETE',`coach/${crypto.randomUUID()}`,200], ['GET','jobs',200]] as const) {
    const response = await worker.fetch(new Request('https://api/v1/' + path, {method, headers: {Authorization: 'Bearer ' + 'a'.repeat(64)}}), bindings);
    expect(response.status).toBe(status);
  }
});
