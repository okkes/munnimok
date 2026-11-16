package app.munni;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.os.Build;
import androidx.annotation.RequiresApi;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Tells the web layer how the app's processes ended lately: Android's own record of it (from Android 11 on), the
 * stack trace of an exception nothing caught, and the note of a web view process that died. The web layer reports
 * what was not somebody's choice (lib/nativeExit.ts).
 */
@CapacitorPlugin(name = "ExitReasons")
public class ExitReasonsPlugin extends Plugin {

    /** how many of the system's records are read: a crash loop is several of the same */
    private static final int RECORDS = 8;

    @PluginMethod
    public void recent(PluginCall call) {
        JSObject result = new JSObject();
        JSArray exits = new JSArray();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) addExits(exits);
        } catch (Throwable ignored) {
            // a report that cannot be read is no report: the app starts as it would have
        }
        result.put("exits", exits);
        result.put("javaCrash", LastExit.take(getContext(), LastExit.CRASH_FILE));
        result.put("renderer", LastExit.take(getContext(), LastExit.RENDERER_FILE));
        call.resolve(result);
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private void addExits(JSArray exits) {
        ActivityManager manager = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        if (manager == null) return;
        for (ApplicationExitInfo info : manager.getHistoricalProcessExitReasons(null, 0, RECORDS)) {
            JSObject exit = new JSObject();
            exit.put("at", info.getTimestamp());
            exit.put("reason", info.getReason());
            exit.put("description", info.getDescription());
            exit.put("importance", info.getImportance());
            exit.put("status", info.getStatus());
            exit.put("pssKb", info.getPss());
            exit.put("rssKb", info.getRss());
            exit.put("process", info.getProcessName());
            exits.put(exit);
        }
    }
}
