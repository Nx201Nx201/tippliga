import apiHandler from "../netlify/functions/api.mjs";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handleVercelRequest(request, response) {
  try {
    const protocol = request.headers["x-forwarded-proto"] || "https";
    const host = request.headers.host;
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined && name !== "host" && name !== "connection") {
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
    }

    let body;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const chunks = [];
      let byteLength = 0;
      for await (const chunk of request) {
        byteLength += chunk.length;
        if (byteLength > 32_768) {
          response.status(413).json({ error: "Die Anfrage ist leer oder zu groß." });
          return;
        }
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }

    const url = new URL(request.url || "/", `${protocol}://${host}`);
    const webRequest = new Request(url, {
      method: request.method,
      headers,
      body,
    });
    const webResponse = await apiHandler(webRequest);
    response.status(webResponse.status);
    for (const [name, value] of webResponse.headers) {
      if (name.toLowerCase() !== "set-cookie") response.setHeader(name, value);
    }
    const cookies = webResponse.headers.getSetCookie?.();
    if (cookies?.length) response.setHeader("Set-Cookie", cookies);
    response.send(Buffer.from(await webResponse.arrayBuffer()));
  } catch (error) {
    console.error("Vercel API request failed:", error);
    response.status(500).json({ error: "Die Anfrage konnte nicht verarbeitet werden." });
  }
}
