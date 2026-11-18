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
          } else {
            long count = (id.equals("oversize") ? 256 : Integer.parseInt(id.substring(5))) * 1024L * 1024L;
            if (id.equals("oversize")) count++;
            byte[] buffer = new byte[65536]; Arrays.fill(buffer, (byte)'a');
            while (count > 0) { int n = (int)Math.min(count, buffer.length); out.write(buffer, 0, n); count -= n; }
          }
          Log.i("KifumatePipe", "END " + id + " " + System.currentTimeMillis());
        } catch (Exception e) { Log.e("KifumatePipe", "WRITE " + id, e); }
      }, "kifumate-validation-pipe").start();
      return pipe[0];
    } catch (Exception e) { throw new FileNotFoundException(e.toString()); }
  }
}
