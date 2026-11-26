export function Sample({ html }: { html: string }) {
  // ruleid: rk-token-in-web-storage
  localStorage.setItem("accessToken", token);
  // ok: rk-token-in-web-storage
  localStorage.setItem("theme", theme);
  // ok: rk-token-in-web-storage
  sessionStorage.setItem("app:session-notice", notice);
  // ruleid: rk-token-in-web-storage
  sessionStorage.setItem("sessionId", id);
  // ruleid: rk-dom-inner-html
  element.innerHTML = html;
  // ok: rk-dom-inner-html
  element.innerHTML = "<b>x</b>";
  // ruleid: rk-eval
  eval(code);
  // ruleid: rk-react-dangerous-html
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
