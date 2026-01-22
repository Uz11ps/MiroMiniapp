export type GameShort = {
  id: string;
  title: string;
  description: string;
  rating: number;
  tags: string[];
  author: string;
  coverUrl: string;
};

export type Character = {
  id: string;
  gameId?: string | null;
  name: string;
  gender?: string | null;
  race?: string | null;
  avatarUrl: string;
  description?: string | null;
  rating?: number | null;
  role?: string | null;
  voiceId?: string | null;
  persona?: string | null;
  origin?: string | null;
  isPlayable?: boolean;

  // D&D 5e Stats
  level?: number;
  class?: string | null;
  hp?: number;
  maxHp?: number;
  ac?: number;
  str?: number;
  dex?: number;
  con?: number;
  int?: number;
  wis?: number;
  cha?: number;
  skills?: any;
  inventory?: any;
  spells?: any;
  equipment?: any;
  initiative?: number;
  speed?: string | null;
  proficiencyBonus?: number;
  savingThrows?: any;
  proficiencies?: any;
  languages?: any;
  alignment?: string | null;
  background?: string | null;
  experiencePoints?: number;
  features?: any;
};

export type Game = GameShort & {
  gallery: string[];
  rules: string;
  editions: { id: string; name: string; description: string; price: number; badge?: string }[];
  worldRules?: string;
  gameplayRules?: string;
  characters?: Character[];
  locations?: { id: string; order: number; title: string; description?: string | null; backgroundUrl?: string | null; musicUrl?: string | null }[];
};

function getApiBase(): string {
  if (typeof window === 'undefined') return 'http://localhost:4000/api';
  const host = window.location.hostname; // e.g. app.miraplay.ru
  const parts = host.split('.');
  const root = parts.slice(-2).join('.');
  if (root === 'localhost') return 'http://localhost:4000/api';
  return `${window.location.protocol}//api.${root}/api`;
}
const API = getApiBase();

export async function fetchGames(): Promise<GameShort[]> {
  const res = await fetch(`${API}/games`);
  if (!res.ok) throw new Error('Failed to load games');
  return res.json();
}

// --- Engine (sessions) ---
export type EngineLocation = { id: string; title: string; description?: string | null; backgroundUrl?: string | null; musicUrl?: string | null; rulesPrompt?: string | null };
export type EngineExit = { id: string; type: 'BUTTON' | 'TRIGGER' | 'GAMEOVER'; buttonText?: string | null; triggerText?: string | null; targetLocationId?: string | null; isGameOver?: boolean };
export type EngineSession = { id: string; gameId: string; location: EngineLocation; exits: EngineExit[] };

export async function startEngineSession(params: { gameId: string; lobbyId?: string; preserve?: boolean }): Promise<{ id: string; currentLocationId: string }> {
  // Передаём идентификацию, иначе сервер вернёт user_required в соло
  let userId: string | undefined; let tgId: string | undefined; let tgUsername: string | undefined;
  try { userId = (typeof window !== 'undefined' && window.localStorage.getItem('mira_user_id')) || undefined; } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wa: any = (typeof window !== 'undefined' ? (window as unknown as { Telegram?: unknown }).Telegram : undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const initDataUnsafe = wa?.WebApp?.initDataUnsafe as { user?: { id?: number; username?: string } } | undefined;
    if (initDataUnsafe?.user?.id) tgId = String(initDataUnsafe.user.id);
    if (initDataUnsafe?.user?.username) tgUsername = initDataUnsafe.user.username;
  } catch {}
  const body: any = { gameId: params.gameId, deviceId: getDeviceId() };
  if (userId) body.userId = userId;
  if (tgId) body.tgId = tgId;
  if (tgUsername) body.tgUsername = tgUsername;
  if (params.lobbyId) body.lobbyId = params.lobbyId;
  if (params.preserve === true) body.preserve = true;
  const res = await fetch(`${API}/engine/session/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('engine_start_failed');
  return res.json();
}

export async function getEngineSession(sessionId: string): Promise<EngineSession> {
  const res = await fetch(`${API}/engine/session/${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error('engine_get_failed');
  return res.json();
}

export async function describeEngineSession(sessionId: string): Promise<{ text: string; fallback?: boolean }> {
  const res = await fetch(`${API}/engine/session/${encodeURIComponent(sessionId)}/describe`, { method: 'POST' });
  if (!res.ok) throw new Error('engine_describe_failed');
  return res.json();
}

export async function fetchGame(id: string): Promise<Game> {
  const res = await fetch(`${API}/games/${id}`);
  if (!res.ok) throw new Error('Not found');
  return res.json();
}

export type Profile = {
  id: string; name: string; avatarUrl: string; subscriptionUntil: string; totalEarned: number; totalFriends: number; autoRenewal: boolean; cardMasked: string;
};
export async function fetchProfile(): Promise<Profile> {
  let tgId: string | undefined;
  let tgUsername: string | undefined;
  let userId: string | undefined;
  let firstName: string | undefined;
  let lastName: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wa: any = (typeof window !== 'undefined' ? (window as unknown as { Telegram?: unknown }).Telegram : undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const initDataUnsafe = wa?.WebApp?.initDataUnsafe as { user?: { id?: number; username?: string; first_name?: string; last_name?: string } } | undefined;
    if (initDataUnsafe?.user?.id) tgId = String(initDataUnsafe.user.id);
    if (initDataUnsafe?.user?.username) tgUsername = initDataUnsafe.user.username;
    if (initDataUnsafe?.user?.first_name) firstName = initDataUnsafe.user.first_name;
    if (initDataUnsafe?.user?.last_name) lastName = initDataUnsafe.user.last_name;
  } catch {}
  try { userId = (typeof window !== 'undefined' && window.localStorage.getItem('mira_user_id')) || undefined; } catch {}
  const params = new URLSearchParams();
  if (tgId) params.set('tgId', tgId);
  if (tgUsername) params.set('tgUsername', tgUsername);
  if (userId) params.set('userId', userId);
  if (firstName) params.set('firstName', firstName);
  if (lastName) params.set('lastName', lastName);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(`${API}/profile${qs}`);
  if (!res.ok) throw new Error('Failed');
  return res.json();
}

export type Friend = { id: string; name: string; avatarUrl: string };
export async function fetchFriends(): Promise<Friend[]> {
  // пробуем реальный список из БД, с фолбэком на мок
  let userId: string | undefined; let tgId: string | undefined; let tgUsername: string | undefined;
  try { userId = (typeof window !== 'undefined' && window.localStorage.getItem('mira_user_id')) || undefined; } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wa: any = (typeof window !== 'undefined' ? (window as unknown as { Telegram?: unknown }).Telegram : undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const initDataUnsafe = wa?.WebApp?.initDataUnsafe as { user?: { id?: number; username?: string } } | undefined;
    if (initDataUnsafe?.user?.id) tgId = String(initDataUnsafe.user.id);
    if (initDataUnsafe?.user?.username) tgUsername = initDataUnsafe.user.username;
  } catch {}
  const qs = new URLSearchParams();
  if (userId) qs.set('userId', userId);
  if (tgId) qs.set('tgId', tgId);
  if (tgUsername) qs.set('tgUsername', tgUsername);
  const url = `${API}/friends/list${qs.toString() ? `?${qs}` : ''}`;
  const res = await fetch(url);
  if (res.ok) return res.json();
  // fallback
  const res2 = await fetch(`${API}/friends`);
  if (!res2.ok) throw new Error('Failed');
  return res2.json();
}

export async function createFriendInvite(): Promise<{ code: string; tgLink?: string }> {
  let userId: string | undefined; let tgId: string | undefined; let tgUsername: string | undefined;
  try { userId = (typeof window !== 'undefined' && window.localStorage.getItem('mira_user_id')) || undefined; } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wa: any = (typeof window !== 'undefined' ? (window as unknown as { Telegram?: unknown }).Telegram : undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const initDataUnsafe = wa?.WebApp?.initDataUnsafe as { user?: { id?: number; username?: string } } | undefined;
    if (initDataUnsafe?.user?.id) tgId = String(initDataUnsafe.user.id);
    if (initDataUnsafe?.user?.username) tgUsername = initDataUnsafe.user.username;
  } catch {}
  const body = { userId, tgId, tgUsername, ttlHours: 24 * 7 };
  const res = await fetch(`${API}/friends/invite/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('Failed');
  return res.json();
}

export async function addFriendByUsername(username: string): Promise<{ ok: true }> {
  let userId: string | undefined; let tgId: string | undefined; let tgUsername: string | undefined;
  try { userId = (typeof window !== 'undefined' && window.localStorage.getItem('mira_user_id')) || undefined; } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wa: any = (typeof window !== 'undefined' ? (window as unknown as { Telegram?: unknown }).Telegram : undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const initDataUnsafe = wa?.WebApp?.initDataUnsafe as { user?: { id?: number; username?: string } } | undefined;
    if (initDataUnsafe?.user?.id) tgId = String(initDataUnsafe.user.id);
    if (initDataUnsafe?.user?.username) tgUsername = initDataUnsafe.user.username;
  } catch {}
  const body = { userId, tgId, tgUsername, username };
  const res = await fetch(`${API}/friends/addByUsername`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('Failed');
  return res.json();
}

export async function sendFeedback(payload: { rating: number; comment?: string; gameId?: string }) {
  let userId: string | undefined;
  let tgId: string | undefined;
  let tgUsername: string | undefined;
  try { userId = (typeof window !== 'undefined' && window.localStorage.getItem('mira_user_id')) || undefined; } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wa: any = (typeof window !== 'undefined' ? (window as unknown as { Telegram?: unknown }).Telegram : undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const initDataUnsafe = wa?.WebApp?.initDataUnsafe as { user?: { id?: number; username?: string } } | undefined;
    if (initDataUnsafe?.user?.id) tgId = String(initDataUnsafe.user.id);
    if (initDataUnsafe?.user?.username) tgUsername = initDataUnsafe.user.username;
  } catch {}
  const body = { ...payload, userId, tgId, tgUsername };
  const res = await fetch(`${API}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('Failed');
  return res.json();
}

export async function fetchCharacters(params?: { gameId?: string; isPlayable?: boolean }): Promise<Character[]> {
  const qs = new URLSearchParams();
  if (params?.gameId) qs.set('gameId', params.gameId);
  if (typeof params?.isPlayable === 'boolean') qs.set('isPlayable', params.isPlayable ? '1' : '0');
  const url = `${API}/characters${qs.toString() ? `?${qs}` : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed');
  return res.json();
}
export async function fetchCharacterById(id: string): Promise<Character> {
  const res = await fetch(`${API}/characters/${id}`);
  if (!res.ok) throw new Error('Not found');
  return res.json();
}
export async function updateCharacter(id: string, patch: Partial<Character>): Promise<Character> {
  const res = await fetch(`${API}/characters/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('Failed to update character');
  return res.json();
}

export type LocationItem = { id: string; order: number; title: string; description?: string | null; backgroundUrl?: string | null; musicUrl?: string | null };
export async function fetchLocations(gameId: string): Promise<LocationItem[]> {
  const res = await fetch(`${API}/games/${encodeURIComponent(gameId)}/locations`);
  if (!res.ok) throw new Error('Failed');
  return res.json();
}

// Chat history API
type ChatMsg = { from: 'bot' | 'me'; text: string };

function getDeviceId(): string {
  try {
    const key = 'mira_device_id';
    let v = (typeof window !== 'undefined' && window.localStorage.getItem(key)) || '';
    if (!v) {
      v = Math.random().toString(36).slice(2) + Date.now().toString(36);
      if (typeof window !== 'undefined') window.localStorage.setItem(key, v);
    }
    return v;
  } catch { return 'dev'; }
}

export async function getChatHistory(gameId: string, lobbyId?: string): Promise<ChatMsg[]> {
  let userId: string | undefined; let tgId: string | undefined; let tgUsername: string | undefined;
  try { userId = (typeof window !== 'undefined' && window.localStorage.getItem('mira_user_id')) || undefined; } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wa: any = (typeof window !== 'undefined' ? (window as unknown as { Telegram?: unknown }).Telegram : undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const initDataUnsafe = wa?.WebApp?.initDataUnsafe as { user?: { id?: number; username?: string } } | undefined;
    if (initDataUnsafe?.user?.id) tgId = String(initDataUnsafe.user.id);
    if (initDataUnsafe?.user?.username) tgUsername = initDataUnsafe.user.username;
  } catch {}
  const qs = new URLSearchParams({ gameId, deviceId: getDeviceId() });
  if (lobbyId) qs.set('lobbyId', lobbyId);
  if (userId) qs.set('userId', userId);
  if (tgId) qs.set('tgId', tgId);
  if (tgUsername) qs.set('tgUsername', tgUsername);
  const res = await fetch(`${API}/chat/history?${qs.toString()}`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.history) ? data.history as ChatMsg[] : [];
}

export async function saveChatHistory(gameId: string, history: ChatMsg[], lobbyId?: string): Promise<void> {
  let userId: string | undefined; let tgId: string | undefined; let tgUsername: string | undefined;
  try { userId = (typeof window !== 'undefined' && window.localStorage.getItem('mira_user_id')) || undefined; } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wa: any = (typeof window !== 'undefined' ? (window as unknown as { Telegram?: unknown }).Telegram : undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const initDataUnsafe = wa?.WebApp?.initDataUnsafe as { user?: { id?: number; username?: string } } | undefined;
    if (initDataUnsafe?.user?.id) tgId = String(initDataUnsafe.user.id);
    if (initDataUnsafe?.user?.username) tgUsername = initDataUnsafe.user.username;
  } catch {}
  const body: any = { gameId, history, userId, tgId, tgUsername, deviceId: getDeviceId() };
  if (lobbyId) body.lobbyId = lobbyId;
  await fetch(`${API}/chat/save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

export async function resetChatHistory(gameId: string, lobbyId?: string): Promise<void> {
  let userId: string | undefined; let tgId: string | undefined; let tgUsername: string | undefined;
  try { userId = (typeof window !== 'undefined' && window.localStorage.getItem('mira_user_id')) || undefined; } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wa: any = (typeof window !== 'undefined' ? (window as unknown as { Telegram?: unknown }).Telegram : undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const initDataUnsafe = wa?.WebApp?.initDataUnsafe as { user?: { id?: number; username?: string } } | undefined;
    if (initDataUnsafe?.user?.id) tgId = String(initDataUnsafe.user.id);
    if (initDataUnsafe?.user?.username) tgUsername = initDataUnsafe.user.username;
  } catch {}
  const qs = new URLSearchParams({ gameId, deviceId: getDeviceId() });
  if (lobbyId) qs.set('lobbyId', lobbyId);
  if (userId) qs.set('userId', userId);
  if (tgId) qs.set('tgId', tgId);
  if (tgUsername) qs.set('tgUsername', tgUsername);
  await fetch(`${API}/chat/history?${qs.toString()}`, { method: 'DELETE' }).catch(() => {});
}

export async function transcribeAudio(blob: Blob): Promise<string> {
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const root = host.split('.').slice(-2).join('.');
  const apiBase = root === 'localhost' ? 'http://localhost:4000/api' : `${typeof window !== 'undefined' ? window.location.protocol : 'https:'}//api.${root}/api`;
  const form = new FormData();
  const type = blob.type || 'audio/webm';
  const ext = type.includes('webm') ? 'webm' : type.includes('mp4') ? 'mp4' : type.includes('mpeg') ? 'mp3' : type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : 'dat';
  form.append('audio', blob, `voice.${ext}`);
  const res = await fetch(`${apiBase}/chat/transcribe`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Transcribe failed: ${res.status}`);
  const data = await res.json().catch(() => ({} as { text?: string }));
  return String((data as { text?: string }).text || '');
}

export type NewUser = {
  firstName: string;
  lastName: string;
  tgUsername?: string;
  tgId?: string;
};

export async function createUser(payload: NewUser) {
  const res = await fetch(`${API}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed');
  return res.json();
}

export async function findUserByTgId(tgId: string) {
  const res = await fetch(`${API}/users?q=${encodeURIComponent(tgId)}&limit=1`);
  if (!res.ok) throw new Error('Failed');
  const data = (await res.json()) as { data?: unknown[] };
  return Array.isArray(data.data) && data.data.length ? data.data[0] : null;
}

// --- Realtime & Lobbies ---
function getWsBase(): string {
  if (typeof window === 'undefined') return 'ws://localhost:4000/ws';
  const host = window.location.hostname;
  const parts = host.split('.');
  const root = parts.slice(-2).join('.');
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  if (root === 'localhost') return `${proto}://localhost:4000/ws`;
  return `${proto}://api.${root}/ws`;
}

export type RealtimeEvent =
  | { type: 'lobby_invite'; lobbyId: string; fromUserId: string; gameId?: string; expiresAt: string }
  | { type: 'lobby_member_joined'; lobbyId: string; userId: string }
  | { type: 'lobby_member_left'; lobbyId: string; userId: string }
  | { type: 'lobby_started'; lobbyId: string; gameId?: string }
  | { type: 'turn_changed'; lobbyId: string; userId: string }
  | { type: 'chat_updated'; lobbyId: string };

export function connectRealtime(onEvent: (e: RealtimeEvent) => void): { close: () => void } {
  let userId: string | undefined; let tgId: string | undefined; let tgUsername: string | undefined;
  try { userId = (typeof window !== 'undefined' && window.localStorage.getItem('mira_user_id')) || undefined; } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wa: any = (typeof window !== 'undefined' ? (window as unknown as { Telegram?: unknown }).Telegram : undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const initDataUnsafe = wa?.WebApp?.initDataUnsafe as { user?: { id?: number; username?: string } } | undefined;
    if (initDataUnsafe?.user?.id) tgId = String(initDataUnsafe.user.id);
    if (initDataUnsafe?.user?.username) tgUsername = initDataUnsafe.user.username;
  } catch {}
  const deviceId = getDeviceId();
  const url = new URL(getWsBase());
  if (userId) url.searchParams.set('userId', userId);
  if (tgId) url.searchParams.set('tgId', tgId);
  if (tgUsername) url.searchParams.set('tgUsername', tgUsername);
  if (deviceId) url.searchParams.set('deviceId', deviceId);
  const ws = new WebSocket(url.toString());
  ws.onmessage = (msg) => {
    try { const e = JSON.parse(String(msg.data)) as RealtimeEvent; if (e && e.type) onEvent(e); } catch {}
  };
  return { close: () => { try { ws.close(); } catch {} } };
}

export type Lobby = { id: string; gameId?: string; status: 'OPEN' | 'RUNNING' | 'CLOSED'; hostUserId: string; maxPlayers: number; members: { userId: string; role: 'HOST' | 'PLAYER'; name: string; avatarUrl: string }[]; invited?: { userId: string; name: string; avatarUrl: string }[]; inviteExpiresAt?: string; currentTurnUserId?: string };

export async function createLobby(params: { gameId?: string; maxPlayers?: number }) {
  let userId: string | undefined; let tgId: string | undefined; let tgUsername: string | undefined;
  try { userId = (typeof window !== 'undefined' && window.localStorage.getItem('mira_user_id')) || undefined; } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wa: any = (typeof window !== 'undefined' ? (window as unknown as { Telegram?: unknown }).Telegram : undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const initDataUnsafe = wa?.WebApp?.initDataUnsafe as { user?: { id?: number; username?: string } } | undefined;
    if (initDataUnsafe?.user?.id) tgId = String(initDataUnsafe.user.id);
    if (initDataUnsafe?.user?.username) tgUsername = initDataUnsafe.user.username;
  } catch {}
  const res = await fetch(`${API}/lobbies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...params, userId, tgId, tgUsername }) });
  if (!res.ok) throw new Error('Failed');
  return res.json() as Promise<Lobby>;
}

export async function getLobby(lobbyId: string): Promise<Lobby | null> {
  const res = await fetch(`${API}/lobbies/${encodeURIComponent(lobbyId)}`);
  if (!res.ok) return null;
  return res.json() as Promise<Lobby>;
}

export async function inviteToLobby(lobbyId: string, invitees: string[]) {
  let userId: string | undefined; let tgId: string | undefined; let tgUsername: string | undefined;
  try { userId = (typeof window !== 'undefined' && window.localStorage.getItem('mira_user_id')) || undefined; } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wa: any = (typeof window !== 'undefined' ? (window as unknown as { Telegram?: unknown }).Telegram : undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const initDataUnsafe = wa?.WebApp?.initDataUnsafe as { user?: { id?: number; username?: string } } | undefined;
    if (initDataUnsafe?.user?.id) tgId = String(initDataUnsafe.user.id);
    if (initDataUnsafe?.user?.username) tgUsername = initDataUnsafe.user.username;
  } catch {}
  const res = await fetch(`${API}/lobbies/${encodeURIComponent(lobbyId)}/invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invitees, userId, tgId, tgUsername })
  });
  if (!res.ok) throw new Error('Failed');
  return res.json() as Promise<{ ok: boolean; expiresAt: string; invited: string[] }>;
}

export async function kickFromLobby(lobbyId: string, userId: string) {
  let hostUserId: string | undefined; let tgId: string | undefined; let tgUsername: string | undefined;
  try { hostUserId = (typeof window !== 'undefined' && window.localStorage.getItem('mira_user_id')) || undefined; } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wa: any = (typeof window !== 'undefined' ? (window as unknown as { Telegram?: unknown }).Telegram : undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const initDataUnsafe = wa?.WebApp?.initDataUnsafe as { user?: { id?: number; username?: string } } | undefined;
    if (initDataUnsafe?.user?.id) tgId = String(initDataUnsafe.user.id);
    if (initDataUnsafe?.user?.username) tgUsername = initDataUnsafe.user.username;
  } catch {}
  const qs = new URLSearchParams();
  if (hostUserId) qs.set('userId', hostUserId);
  if (tgId) qs.set('tgId', tgId);
  if (tgUsername) qs.set('tgUsername', tgUsername);
  const res = await fetch(`${API}/lobbies/${encodeURIComponent(lobbyId)}/members/${encodeURIComponent(userId)}${qs.toString() ? `?${qs}` : ''}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) throw new Error('Failed');
}

export async function reinviteToLobby(lobbyId: string, userId: string) {
  return inviteToLobby(lobbyId, [userId]);
}

export async function joinLobby(lobbyId: string) {
  let userId: string | undefined; let tgId: string | undefined; let tgUsername: string | undefined;
  try { userId = (typeof window !== 'undefined' && window.localStorage.getItem('mira_user_id')) || undefined; } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wa: any = (typeof window !== 'undefined' ? (window as unknown as { Telegram?: unknown }).Telegram : undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const initDataUnsafe = wa?.WebApp?.initDataUnsafe as { user?: { id?: number; username?: string } } | undefined;
    if (initDataUnsafe?.user?.id) tgId = String(initDataUnsafe.user.id);
    if (initDataUnsafe?.user?.username) tgUsername = initDataUnsafe.user.username;
  } catch {}
  const res = await fetch(`${API}/lobbies/${encodeURIComponent(lobbyId)}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, tgId, tgUsername }) });
  if (!res.ok) throw new Error('Failed');
  return res.json() as Promise<Lobby | { ok: true }>;
}

export async function startLobby(lobbyId: string) {
  let userId: string | undefined; let tgId: string | undefined; let tgUsername: string | undefined;
  try { userId = (typeof window !== 'undefined' && window.localStorage.getItem('mira_user_id')) || undefined; } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wa: any = (typeof window !== 'undefined' ? (window as unknown as { Telegram?: unknown }).Telegram : undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const initDataUnsafe = wa?.WebApp?.initDataUnsafe as { user?: { id?: number; username?: string } } | undefined;
    if (initDataUnsafe?.user?.id) tgId = String(initDataUnsafe.user.id);
    if (initDataUnsafe?.user?.username) tgUsername = initDataUnsafe.user.username;
  } catch {}
  const res = await fetch(`${API}/lobbies/${encodeURIComponent(lobbyId)}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, tgId, tgUsername }) });
  if (!res.ok) throw new Error('Failed');
  return res.json() as Promise<Lobby>;
}

export async function getMyLobbies(): Promise<Lobby[]> {
  let userId: string | undefined; let tgId: string | undefined; let tgUsername: string | undefined;
  try { userId = (typeof window !== 'undefined' && window.localStorage.getItem('mira_user_id')) || undefined; } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wa: any = (typeof window !== 'undefined' ? (window as unknown as { Telegram?: unknown }).Telegram : undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const initDataUnsafe = wa?.WebApp?.initDataUnsafe as { user?: { id?: number; username?: string } } | undefined;
    if (initDataUnsafe?.user?.id) tgId = String(initDataUnsafe.user.id);
    if (initDataUnsafe?.user?.username) tgUsername = initDataUnsafe.user.username;
  } catch {}
  const qs = new URLSearchParams();
  if (userId) qs.set('userId', userId);
  if (tgId) qs.set('tgId', tgId);
  if (tgUsername) qs.set('tgUsername', tgUsername);
  const res = await fetch(`${API}/lobbies${qs.toString() ? `?${qs}` : ''}`);
  if (!res.ok) return [];
  return res.json() as Promise<Lobby[]>;
}

export async function leaveLobby(lobbyId: string): Promise<void> {
  let userId: string | undefined; let tgId: string | undefined; let tgUsername: string | undefined;
  try { userId = (typeof window !== 'undefined' && window.localStorage.getItem('mira_user_id')) || undefined; } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wa: any = (typeof window !== 'undefined' ? (window as unknown as { Telegram?: unknown }).Telegram : undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const initDataUnsafe = wa?.WebApp?.initDataUnsafe as { user?: { id?: number; username?: string } } | undefined;
    if (initDataUnsafe?.user?.id) tgId = String(initDataUnsafe.user.id);
    if (initDataUnsafe?.user?.username) tgUsername = initDataUnsafe.user.username;
  } catch {}
  const qs = new URLSearchParams();
  if (userId) qs.set('userId', userId);
  if (tgId) qs.set('tgId', tgId);
  if (tgUsername) qs.set('tgUsername', tgUsername);
  await fetch(`${API}/lobbies/${encodeURIComponent(lobbyId)}/leave${qs.toString() ? `?${qs}` : ''}`, { method: 'DELETE' }).catch(() => {});
}

export async function ttsSynthesize(
  text: string, 
  options?: {
    voice?: string;
    format?: 'mp3' | 'oggopus';
    characterId?: string;
    locationId?: string;
    gender?: string;
    isNarrator?: boolean;
  }
): Promise<Blob> {
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const root = host.split('.').slice(-2).join('.');
  const apiBase = root === 'localhost' ? 'http://localhost:4000/api' : `${typeof window !== 'undefined' ? window.location.protocol : 'https:'}//api.${root}/api`;
  // Определим поддержку ogg/opus браузером
  let preferOgg = false;
  try {
    const a = typeof Audio !== 'undefined' ? new Audio() : null;
    preferOgg = !!(a && typeof a.canPlayType === 'function' && a.canPlayType('audio/ogg; codecs=opus'));
  } catch { preferOgg = false; }
  const format = options?.format || (preferOgg ? 'oggopus' : 'mp3');
  
  const body: any = {
    text,
    format,
    lang: 'ru-RU',
  };
  
  // Передаем контекст для выбора голоса
  if (options?.characterId) body.characterId = options.characterId;
  if (options?.locationId) body.locationId = options.locationId;
  if (options?.gender) body.gender = options.gender;
  if (options?.isNarrator !== undefined) body.isNarrator = options.isNarrator;
  if (options?.voice) body.voice = options.voice;
  
  const res = await fetch(`${apiBase}/tts`, { 
    method: 'POST', 
    headers: { 'Content-Type': 'application/json' }, 
    body: JSON.stringify(body) 
  });
  
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`TTS failed: ${errText}`);
  }
  
  return await res.blob();
}

export async function generateBackground(prompt: string, size?: { width: number; height: number }): Promise<string> {
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const root = host.split('.').slice(-2).join('.');
  const apiBase = root === 'localhost' ? 'http://localhost:4000/api' : `${typeof window !== 'undefined' ? window.location.protocol : 'https:'}//api.${root}/api`;
  const body: any = { prompt: String(prompt || '').slice(0, 1800), provider: 'gemini' };
  if (size) { body.width = size.width; body.height = size.height; }
  const res = await fetch(`${apiBase}/image/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) return '';
  const data = await res.json().catch(() => ({} as any));
  return String((data as any).dataUrl || '');
}

export async function rollDiceApi(params: { expr?: string; count?: number; sides?: number; mod?: number; adv?: boolean; dis?: boolean; dc?: number; context?: string; kind?: string; lobbyId?: string; gameId?: string; manualResults?: number[] }): Promise<{ ok: boolean; message?: string; results?: any[]; messages?: string[] }> {
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const root = host.split('.').slice(-2).join('.');
  const apiBase = root === 'localhost' ? 'http://localhost:4000/api' : `${typeof window !== 'undefined' ? window.location.protocol : 'https:'}//api.${root}/api`;
  const body: any = {};
  if (params.expr) body.expr = params.expr;
  if (typeof params.count === 'number') body.count = params.count;
  if (typeof params.sides === 'number') body.sides = params.sides;
  if (typeof params.mod === 'number') body.mod = params.mod;
  if (params.adv) body.adv = true;
  if (params.dis) body.dis = true;
  if (typeof params.dc === 'number') body.dc = params.dc;
  if (typeof params.context === 'string') body.context = params.context;
  if (typeof params.kind === 'string') body.kind = params.kind;
  if (params.gameId) body.gameId = params.gameId;
  if (Array.isArray(params.manualResults)) body.manualResults = params.manualResults;
  // Добавим идентификацию (требуется для /api/chat/dice)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wa: any = (typeof window !== 'undefined' ? (window as unknown as { Telegram?: unknown }).Telegram : undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const initDataUnsafe = wa?.WebApp?.initDataUnsafe as { user?: { id?: number; username?: string } } | undefined;
    const tgId = initDataUnsafe?.user?.id ? String(initDataUnsafe.user.id) : undefined;
    const tgUsername = initDataUnsafe?.user?.username || undefined;
    if (tgId) body.tgId = tgId;
    if (tgUsername) body.tgUsername = tgUsername;
  } catch {}
  try {
    const userId = (typeof window !== 'undefined' && window.localStorage.getItem('mira_user_id')) || undefined;
    if (userId) body.userId = userId;
  } catch {}
  if (!body.userId && !body.tgId && !body.tgUsername) {
    try {
      const key = 'mira_device_id';
      let v = window.localStorage.getItem(key) || '';
      if (!v) { v = Math.random().toString(36).slice(2) + Date.now().toString(36); window.localStorage.setItem(key, v); }
      body.deviceId = v;
    } catch {
      body.deviceId = 'dev';
    }
  }
  if (params.lobbyId) {
    const res = await fetch(`${apiBase}/lobbies/${encodeURIComponent(params.lobbyId)}/dice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({} as any));
    return data as any;
  }
  // Соло: пишем в историю чата
  if (params.gameId) {
    const res = await fetch(`${apiBase}/chat/dice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({} as any));
    return data as any;
  }
  const res = await fetch(`${apiBase}/dice/roll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({} as any));
  return data as any;
}


