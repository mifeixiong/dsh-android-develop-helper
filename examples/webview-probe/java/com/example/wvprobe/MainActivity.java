package com.example.wvprobe;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Minimal probe for one question: what does uiautomator actually see inside a
 * WebView, and what does it take to see the rest?
 *
 * The native pair at the top is the control group — those have real
 * `android:id`s. The WebView below renders DOM that carries HTML `id`s, an
 * `aria-label` and a click handler, so the two can be compared node for node.
 *
 * `setWebContentsDebuggingEnabled(true)` is what makes the CDP endpoint appear;
 * it is the difference between "read the page through the accessibility tree"
 * and "query the DOM directly".
 */
public class MainActivity extends Activity {

    private static final String HTML =
        "<!doctype html><html><head>"
        + "<meta name='viewport' content='width=device-width,initial-scale=1'></head>"
        + "<body style='font-family:sans-serif;padding:8px'>"
        + "<h3 id='wv-heading'>网页标题</h3>"
        + "<p id='wv-paragraph'>这段文字来自 DOM，不是原生 View。</p>"
        + "<button id='wv-button' aria-label='网页按钮'>网页按钮</button>"
        + "<p><input id='wv-input' placeholder='网页输入框'></p>"
        + "<div id='wv-out'>结果：(未点击)</div>"
        + "<script>"
        + "document.getElementById('wv-button').addEventListener('click', function(){"
        + "document.getElementById('wv-out').textContent = '结果：按钮被点到了';"
        + "});"
        + "</script>"
        + "</body></html>";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView.setWebContentsDebuggingEnabled(true);
        setContentView(R.layout.activity_main);

        WebView web = findViewById(R.id.webView);
        web.getSettings().setJavaScriptEnabled(true);
        web.setWebViewClient(new WebViewClient());
        // A real origin rather than `null`, so the page is same-origin and the
        // CDP DOM domain has something to report.
        web.loadDataWithBaseURL("https://probe.example/", HTML, "text/html", "utf-8", null);
    }
}
