export function getServerUrl() {
    return localStorage.getItem("djit_server") || "";
}
export function setServerUrl(url) {
  localStorage.setItem("djit_server", url.replace(/\/+$/, ""));
}
