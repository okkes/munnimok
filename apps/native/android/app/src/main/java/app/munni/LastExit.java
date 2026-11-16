package app.munni;

import android.content.Context;
import android.os.Build;
import android.webkit.RenderProcessGoneDetail;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;

/** What ended the app's process, kept for the next start: the web layer's error reporting dies with the process. */
final class LastExit {

    static final String CRASH_FILE = "last-crash.txt";
    static final String RENDERER_FILE = "last-renderer.txt";

    /** a stack trace is cut here: the report is one event, not a file */
    private static final int MAX_CHARS = 6000;

    private static boolean watching;

    private LastExit() {}

    /** chains to the previous handler: the crash itself goes on as it would have */
    static synchronized void watch(Context context) {
        // an activity that is created again must not wrap the handler in itself
        if (watching) return;
        watching = true;
        final File file = new File(context.getFilesDir(), CRASH_FILE);
        final Thread.UncaughtExceptionHandler next = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                StringWriter text = new StringWriter();
                error.printStackTrace(new PrintWriter(text));
                write(file, System.currentTimeMillis() + "\n" + thread.getName() + "\n" + text);
            } catch (Throwable ignored) {
                // out of memory is one of the crashes this is for: failing to note it must not replace it
            }
            if (next != null) next.uncaughtException(thread, error);
        });
    }

    static void noteRendererGone(Context context, RenderProcessGoneDetail detail) {
        try {
            String how = "gone";
            String priority = "";
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                how = detail.didCrash() ? "crashed" : "killed";
                priority = String.valueOf(detail.rendererPriorityAtExit());
            }
            write(new File(context.getFilesDir(), RENDERER_FILE), System.currentTimeMillis() + "\n" + how + "\n" + priority);
        } catch (Throwable ignored) {
            // the app is about to end either way
        }
    }

    /** read once: the note is deleted after it was read; null when there is none */
    static String take(Context context, String name) {
        File file = new File(context.getFilesDir(), name);
        if (!file.exists()) return null;
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) Math.min(file.length(), MAX_CHARS * 4L)];
            int read = in.read(bytes);
            return read <= 0 ? null : new String(bytes, 0, read, StandardCharsets.UTF_8);
        } catch (Throwable ignored) {
            return null;
        } finally {
            file.delete();
        }
    }

    private static void write(File file, String text) throws java.io.IOException {
        String kept = text.length() > MAX_CHARS ? text.substring(0, MAX_CHARS) : text;
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(kept.getBytes(StandardCharsets.UTF_8));
        }
    }
}
