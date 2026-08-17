import * as http from 'http';
import { AddressInfo } from 'net';

/**
 * YouTube's embed refuses to configure itself ("video player configuration error", code 153)
 * unless the request carries a Referer, and a webview has none to give: its documents live on
 * the vscode-webview: scheme, which browsers never send a Referer from. So the embed is hosted
 * one level down, inside a page served from loopback — an ordinary http:// origin YouTube sees
 * as `http://127.0.0.1:<port>/`.
 *
 * Nothing is proxied or downloaded here; the page is a few hundred bytes of markup and the media
 * itself never touches this server.
 */
export class EmbedHost {
  private server?: http.Server;
  private address = '';

  get origin(): string {
    return this.address;
  }

  async start(): Promise<void> {
    const server = http.createServer((request, response) => this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    this.server = server;
    this.address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  dispose() {
    this.server?.close();
    this.server = undefined;
  }

  private handle(request: http.IncomingMessage, response: http.ServerResponse) {
    const url = new URL(request.url ?? '/', this.address);
    const id = url.searchParams.get('v') ?? '';
    // Ids are checked rather than escaped: they go straight into markup below.
    if (url.pathname !== '/embed' || !/^[\w-]{11}$/.test(id)) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(page(id, this.address));
  }
}

function page(id: string, origin: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <style>
    html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
    iframe { display: block; width: 100%; height: 100%; border: 0; }
  </style>
</head>
<body>
  <iframe src="https://www.youtube.com/embed/${id}?autoplay=1&rel=0&origin=${encodeURIComponent(origin)}"
          referrerpolicy="strict-origin-when-cross-origin"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowfullscreen></iframe>
</body>
</html>`;
}
