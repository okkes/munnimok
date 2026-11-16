package app.munni;

import android.os.Bundle;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // first, so that a failure while the app starts is noted too
        LastExit.watch(getApplicationContext());
        registerPlugin(ExitReasonsPlugin.class);
        super.onCreate(savedInstanceState);
        if (getBridge() == null) return;
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                LastExit.noteRendererGone(getApplicationContext(), detail);
                // not handled, on purpose: Android ends the app, and a fresh start is the way back to a working page
                return false;
            }
        });
    }
}
