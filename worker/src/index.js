// ============================================================
// Cloudflare Worker — 対談ツール リアルタイムバックエンド
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // /ws/:roomId  → WebSocket upgrade
    const wsMatch = url.pathname.match(/^\/ws\/([a-zA-Z0-9_-]+)$/);
    if (wsMatch) {
      const roomId = wsMatch[1];
      const id = env.TAIDAN_ROOM.idFromName(roomId);
      const stub = env.TAIDAN_ROOM.get(id);
      return stub.fetch(request);
    }

    // /room/:roomId  → ルーム作成 / 情報取得
    const roomMatch = url.pathname.match(/^\/room\/([a-zA-Z0-9_-]+)$/);
    if (roomMatch) {
      const roomId = roomMatch[1];
      const id = env.TAIDAN_ROOM.idFromName(roomId);
      const stub = env.TAIDAN_ROOM.get(id);
      return stub.fetch(request);
    }

    // / → ヘルスチェック
    if (url.pathname === '/') {
      return json({ ok: true, service: 'taidan-worker' });
    }

    return new Response('Not found', { status: 404 });
  }
};

// ============================================================
// Durable Object — ルームごとの状態 + WebSocket ハブ
// ============================================================
export class TaidanRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // sessionId → { ws, speakerId }
  }

  async fetch(request) {
    const url = new URL(request.url);

    // GET /room/:id → ルームデータ返す
    if (request.method === 'GET' && !request.headers.get('Upgrade')) {
      const data = await this.getRoomData();
      return json(data);
    }

    // POST /room/:id → ルーム初期化 / 議題更新
    if (request.method === 'POST') {
      const body = await request.json();
      if (body.action === 'set_topic') {
        await this.state.storage.put('topic', body.topic);
        this.broadcast({ type: 'topic', topic: body.topic });
        return json({ ok: true });
      }
      return json({ ok: false, error: 'unknown action' }, 400);
    }

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }

    return new Response('Bad request', { status: 400 });
  }

  async handleWebSocket(request) {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();

    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { ws: server, speakerId: null });

    // 接続時に現在の状態を送る
    const data = await this.getRoomData();
    server.send(JSON.stringify({ type: 'init', ...data, sessionId }));

    server.addEventListener('message', async (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        await this.handleMessage(sessionId, msg);
      } catch (e) {
        server.send(JSON.stringify({ type: 'error', message: e.message }));
      }
    });

    server.addEventListener('close', () => {
      this.sessions.delete(sessionId);
      this.broadcast({ type: 'online_count', count: this.sessions.size });
    });

    server.addEventListener('error', () => {
      this.sessions.delete(sessionId);
    });

    this.broadcast({ type: 'online_count', count: this.sessions.size });

    return new Response(null, { status: 101, webSocket: client });
  }

  async handleMessage(sessionId, msg) {
    const session = this.sessions.get(sessionId);

    switch (msg.type) {

      // 話者として参加
      case 'join_speaker': {
        session.speakerId = msg.speakerId;
        break;
      }

      // 話者追加
      case 'add_speaker': {
        const speakers = await this.getSpeakers();
        const speaker = {
          id: msg.id || crypto.randomUUID(),
          name: msg.name,
          color: msg.color,
          createdAt: Date.now()
        };
        speakers.push(speaker);
        await this.state.storage.put('speakers', JSON.stringify(speakers));
        this.broadcast({ type: 'speakers', speakers });
        break;
      }

      // 話者削除
      case 'remove_speaker': {
        let speakers = await this.getSpeakers();
        speakers = speakers.filter(s => s.id !== msg.speakerId);
        await this.state.storage.put('speakers', JSON.stringify(speakers));
        this.broadcast({ type: 'speakers', speakers });
        break;
      }

      // 話者名変更
      case 'rename_speaker': {
        const speakers = await this.getSpeakers();
        const sp = speakers.find(s => s.id === msg.speakerId);
        if (sp) sp.name = msg.name;
        await this.state.storage.put('speakers', JSON.stringify(speakers));
        this.broadcast({ type: 'speakers', speakers });
        break;
      }

      // 発言追加
      case 'add_message': {
        const messages = await this.getMessages();
        const message = {
          id: crypto.randomUUID(),
          speakerId: msg.speakerId,
          text: msg.text,
          ts: Date.now()
        };
        messages.push(message);
        // 最新500件だけ保持
        if (messages.length > 500) messages.splice(0, messages.length - 500);
        await this.state.storage.put('messages', JSON.stringify(messages));
        this.broadcast({ type: 'message', message });
        break;
      }

      // 発言削除
      case 'delete_message': {
        let messages = await this.getMessages();
        messages = messages.filter(m => m.id !== msg.messageId);
        await this.state.storage.put('messages', JSON.stringify(messages));
        this.broadcast({ type: 'delete_message', messageId: msg.messageId });
        break;
      }

      // 議題更新
      case 'set_topic': {
        await this.state.storage.put('topic', msg.topic);
        this.broadcast({ type: 'topic', topic: msg.topic });
        break;
      }

      // AI生成リクエスト → 全員に通知
      case 'ai_generating': {
        this.broadcast({ type: 'ai_generating', by: msg.speakerName });
        break;
      }

      case 'ai_result': {
        this.broadcast({ type: 'ai_result', result: msg.result });
        break;
      }
    }
  }

  broadcast(data, excludeSessionId = null) {
    const str = JSON.stringify(data);
    for (const [sid, session] of this.sessions) {
      if (sid === excludeSessionId) continue;
      try { session.ws.send(str); } catch (_) {}
    }
  }

  async getRoomData() {
    const [topic, speakers, messages] = await Promise.all([
      this.state.storage.get('topic'),
      this.getSpeakers(),
      this.getMessages()
    ]);
    return {
      topic: topic || '',
      speakers,
      messages,
      onlineCount: this.sessions.size
    };
  }

  async getSpeakers() {
    const raw = await this.state.storage.get('speakers');
    return raw ? JSON.parse(raw) : [];
  }

  async getMessages() {
    const raw = await this.state.storage.get('messages');
    return raw ? JSON.parse(raw) : [];
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
