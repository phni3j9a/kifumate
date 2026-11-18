package com.quarterlambda.kifumate.pipevalidation;

import android.database.Cursor;
import android.database.MatrixCursor;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract.Document;
import android.provider.DocumentsContract.Root;
import android.provider.DocumentsProvider;
import android.util.Log;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Arrays;

// テスト専用。合成データと同梱した架空のバックアップだけを、サイズ不明のパイプで返す。
public class PipeProvider extends DocumentsProvider {
  public static class SetupActivity extends android.app.Activity {
    protected void onCreate(android.os.Bundle state) {
      super.onCreate(state);
      for (String id : IDS)
        grantUriPermission("host.exp.exponent", android.net.Uri.parse(
            "content://com.quarterlambda.kifumate.pipevalidation.documents/document/" + id),
            android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
      finish();
    }
  }
  public static class Dump extends android.app.Instrumentation {
    public void onCreate(android.os.Bundle args) { super.onCreate(args); start(); }
    public void onStart() {
      android.os.Bundle result = new android.os.Bundle();
      try {
        org.xmlpull.v1.XmlSerializer xml = android.util.Xml.newSerializer();
        java.io.StringWriter writer = new java.io.StringWriter(); xml.setOutput(writer);
        xml.startDocument("UTF-8", true); xml.startTag(null, "hierarchy");
        android.app.UiAutomation automation = getUiAutomation();
        android.view.accessibility.AccessibilityNodeInfo root = null;
        for (int i=0;i<20 && root==null;i++) { Thread.sleep(100); root=automation.getRootInActiveWindow(); }
        node(xml, root);
        xml.endTag(null, "hierarchy"); xml.endDocument(); result.putString("stream", writer.toString());
      } catch (Exception e) { result.putString("stream", e.toString()); }
      finish(android.app.Activity.RESULT_OK, result);
    }
    private void node(org.xmlpull.v1.XmlSerializer xml, android.view.accessibility.AccessibilityNodeInfo n) throws Exception {
      if (n == null) return;
      android.graphics.Rect r = new android.graphics.Rect(); n.getBoundsInScreen(r);
      xml.startTag(null, "node");
      xml.attribute(null, "text", n.getText() == null ? "" : n.getText().toString());
      xml.attribute(null, "content-desc", n.getContentDescription() == null ? "" : n.getContentDescription().toString());
      xml.attribute(null, "bounds", "["+r.left+","+r.top+"]["+r.right+","+r.bottom+"]");
      for (int i=0;i<n.getChildCount();i++) node(xml,n.getChild(i));
      xml.endTag(null,"node");
    }
  }
  private static final String[] DOCS = {Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME,
      Document.COLUMN_MIME_TYPE, Document.COLUMN_FLAGS, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED};
  private static final String[] IDS = {"backup", "bench4", "bench16", "bench32", "oversize"};
  public boolean onCreate() { return true; }
  public Cursor queryRoots(String[] projection) {
    MatrixCursor c = new MatrixCursor(new String[]{Root.COLUMN_ROOT_ID, Root.COLUMN_DOCUMENT_ID,
        Root.COLUMN_TITLE, Root.COLUMN_FLAGS, Root.COLUMN_MIME_TYPES});
    c.addRow(new Object[]{"pipe", "root", "Kifumate pipe validation", 0, "*/*"});
    return c;
  }
  private void row(MatrixCursor c, String id) {
    c.addRow(new Object[]{id, id.equals("root") ? "Pipe files" : id + ".kifumate",
        id.equals("root") ? Document.MIME_TYPE_DIR : "application/octet-stream", 0, null,
        System.currentTimeMillis()});
  }
  public Cursor queryDocument(String id, String[] projection) {
    MatrixCursor c = new MatrixCursor(DOCS); row(c, id); return c;
  }
  public Cursor queryChildDocuments(String parent, String[] projection, String sort) {
    MatrixCursor c = new MatrixCursor(DOCS); for (String id : IDS) row(c, id); return c;
  }
  public boolean isChildDocument(String parent, String id) { return parent.equals("root"); }
  public ParcelFileDescriptor openDocument(String id, String mode, CancellationSignal signal)
      throws FileNotFoundException {
    if (!Arrays.asList(IDS).contains(id) || !mode.equals("r")) throw new FileNotFoundException(id);
    try {
      ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
      new Thread(() -> {
        long start = System.currentTimeMillis();
        Log.i("KifumatePipe", "START " + id + " " + start);
        try (OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
          if (id.equals("backup")) {
            try (InputStream in = getContext().getAssets().open("backup.kifumate")) {
              byte[] buffer = new byte[65536]; int n;
              while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
            }
          } else if (id.equals("oversize")) {
            long count = 256L * 1024L * 1024L + 1;
            byte[] buffer = new byte[65536]; Arrays.fill(buffer, (byte)'a');
            while (count > 0) { int n = (int)Math.min(count, buffer.length); out.write(buffer, 0, n); count -= n; }
          } else {
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
            try (InputStream in = getContext().getAssets().open("backup.kifumate")) {
              byte[] buffer = new byte[65536]; int n;
              while ((n = in.read(buffer)) != -1) bytes.write(buffer, 0, n);
            }
            String[] lines = new String(bytes.toByteArray(), "UTF-8").split("\n");
            byte[] header = (lines[0] + "\n" + lines[1] + "\n").getBytes("UTF-8");
            byte[] game = (lines[2] + "\n").getBytes("UTF-8");
            int target = Integer.parseInt(id.substring(5)) * 1024 * 1024;
            int games = (target - header.length - 64) / game.length;
            byte[] end = ("{\"type\":\"end\",\"games\":" + games + "}\n").getBytes("UTF-8");
            out.write(header);
            for (int i = 0; i < games; i++) out.write(game);
            int padding = target - header.length - games * game.length - end.length;
            for (int i = 0; i < padding - 1; i++) out.write(' ');
            out.write('\n'); out.write(end);
          }
          Log.i("KifumatePipe", "END " + id + " " + System.currentTimeMillis());
        } catch (Exception e) { Log.e("KifumatePipe", "WRITE " + id, e); }
      }, "kifumate-validation-pipe").start();
      return pipe[0];
    } catch (Exception e) { throw new FileNotFoundException(e.toString()); }
  }
}
