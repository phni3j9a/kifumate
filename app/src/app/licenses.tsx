import { Label, Page } from "../components/ui";
export default function Licenses() {
  return (
    <Page>
      <Label title>オープンソースについて</Label>
      <Label>将棋ルールと棋譜入出力：tsshogi（MIT）</Label>
      <Label muted>Copyright (c) 2023 Kubo, Ryosuke</Label>
      <Label>文字コード変換：encoding-japanese（MIT）</Label>
      <Label muted>Copyright (c) 2012-present polygonplanet</Label>
      <Label muted>
        {
          'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.'
        }
      </Label>
    </Page>
  );
}
