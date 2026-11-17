"""通信なしのローカルコンテナで見本1局を解析する（README参照）。"""
import json
import sys
from bridge import Engine

source = json.load(sys.stdin)
moves = [p['move']['usi'] for p in source['positions'][1:]]
engine = Engine()
try:
    results = [engine.analyze(dict(initial='startpos', moves=moves, mode='precise', ply=i))
               for i in range(len(moves) + 1)]
    json.dump(dict(initial='startpos', moves=moves, mode='precise', results=results,
                   coachProof=None, jobId='bundled-sample-v1'), sys.stdout, ensure_ascii=False)
finally:
    engine.close()
