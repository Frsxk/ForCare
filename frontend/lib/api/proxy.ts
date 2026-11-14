// Imported by next.config.ts only. Never expose backend configuration in a client env variable.
export function apiRewrite(origin = "http://127.0.0.1:3001") {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("FORCARE_BACKEND_ORIGIN must be an HTTP(S) origin");
  }
  if (!(["http:", "https:"].includes(url.protocol)) || url.origin !== origin || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("FORCARE_BACKEND_ORIGIN must be an HTTP(S) origin without credentials, path, query or fragment");
  }
  return { source: "/api/v1/:path*", destination: `${origin}/api/v1/:path*` };
}
