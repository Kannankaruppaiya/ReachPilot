/**
 * Standalone lead-scraper service: runs only the Google → LinkedIn scraper over
 * HTTP so it can live on a VPS (headful Chrome under Xvfb). No DB or Redis; the
 * worker calls it when SCRAPER_SERVICE_URL is set. It never touches a LinkedIn
 * session. Auth is a shared bearer token (SCRAPER_SERVICE_TOKEN); keep the port
 * firewalled.
 */
import * as http from 'http';
import { Logger } from '@nestjs/common';
import { getEnv } from '@/config/env';
import { AiService } from '@/modules/ai/ai.service';
import { LeadScraperService, SearchOptions } from '@/modules/scraping/lead-scraper.service';

const logger = new Logger('ScraperService');
const env = getEnv();
const PORT = env.SCRAPER_SERVICE_PORT;
const TOKEN = env.SCRAPER_SERVICE_TOKEN;

// Its only dependency (AiService) has none, so wire by hand without Nest.
const scraper = new LeadScraperService(new AiService());

/** Read + JSON-parse a request body, capped so a huge payload can't OOM us. */
function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) req.destroy(); // 1 MB guard
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const send = (code: number, obj: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });

  if (req.method === 'POST' && req.url === '/scrape') {
    // Shared-secret auth (skipped only if no token is configured).
    if (TOKEN && req.headers['authorization'] !== `Bearer ${TOKEN}`) {
      return send(401, { ok: false, error: 'unauthorized' });
    }

    let body: any;
    try {
      body = await readBody(req);
    } catch {
      return send(400, { ok: false, error: 'bad_json' });
    }

    const titles: string[] = Array.isArray(body.titles)
      ? body.titles.map((t: any) => String(t || '').trim()).filter(Boolean).slice(0, 6)
      : [];
    if (!titles.length) return send(400, { ok: false, error: 'titles_required' });

    const opts: SearchOptions = {
      titles,
      location: body.location ? String(body.location).trim() : undefined,
      maxResults: Math.min(Math.max(Number(body.maxResults) || 15, 1), 100),
      // The cursor lives on the worker; this service stays stateless.
      startPage: Number.isFinite(Number(body.startPage)) ? Math.max(Number(body.startPage), 0) : undefined,
      pages: Number.isFinite(Number(body.pages)) ? Math.min(Math.max(Number(body.pages), 1), 10) : undefined,
    };

    try {
      const t0 = Date.now();
      const leads = await scraper.search(opts);
      logger.log(`scraped ${leads.length} leads in ${Date.now() - t0}ms (titles: ${titles.join('/')})`);
      return send(200, { ok: true, leads });
    } catch (err: any) {
      logger.error(`scrape failed: ${err?.message || err}`);
      return send(500, { ok: false, error: 'scrape_failed' });
    }
  }

  send(404, { ok: false, error: 'not_found' });
});

server.listen(PORT, () => {
  logger.log(`Lead scraper service listening on :${PORT} (auth ${TOKEN ? 'ON' : 'OFF'})`);
});
