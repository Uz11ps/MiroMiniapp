import React, { useEffect, useMemo, useState } from 'react';
import { Outlet, Link, NavLink, RouteObject, useNavigate, useRoutes, useParams, useLocation } from 'react-router-dom';
import { fetchFriends, fetchGame, fetchGames, fetchProfile, sendFeedback, createUser, findUserByTgId, getChatHistory, saveChatHistory, resetChatHistory, transcribeAudio, createFriendInvite, addFriendByUsername, connectRealtime, inviteToLobby, createLobby, joinLobby, startLobby, getLobby, kickFromLobby, reinviteToLobby, ttsSynthesize, ttsAnalyzeText, generateBackground, rollDiceApi, startEngineSession, getEngineSession, fetchLocations, getMyLobbies, leaveLobby, updateCharacter, stopStreamingTTS, getAudioQueue, initAudioContext, playStreamingTTSChunked } from '../../api';

// CSS импортируется в main.tsx, не нужно дублировать здесь

// Нормализация путей для /uploads в мини‑аппе (общая для всего файла)
function resolveAssetUrlGlobal(u?: string | null): string {
  const raw = String(u || '').trim();
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:')) return raw;
  if (raw.startsWith('/uploads/')) {
    try {
      const host = window.location.hostname;
      const root = host.split('.').slice(-2).join('.');
      const base = root === 'localhost' ? 'http://localhost:4000' : `${window.location.protocol}//api.${root}`;
      return `${base}${raw}`;
    } catch { return raw; }
  }
  return raw;
}

// Мемоизируем BottomNav, чтобы он не пересоздавался при каждом рендере
const BottomNav: React.FC = React.memo(() => {
  return (
    <nav className="bottom-nav">
      <NavLink to="/catalog" className={({ isActive }) => `bottom-item${isActive ? ' active' : ''}`}>Каталог</NavLink>
      <NavLink to="/my" className={({ isActive }) => `bottom-item${isActive ? ' active' : ''}`}>Мои игры</NavLink>
      <NavLink to="/friends" className={({ isActive }) => `bottom-item${isActive ? ' active' : ''}`}>Друзья</NavLink>
      <NavLink to="/profile" className={({ isActive }) => `bottom-item${isActive ? ' active' : ''}`}>Профиль</NavLink>
    </nav>
  );
});

const GameChat: React.FC = () => {
  const navigate = useNavigate();
  const { id: routeId } = useParams<{ id?: string }>();
  const location = useLocation();
  const id = routeId || '1';
  const [self, setSelf] = useState<{ name: string; avatar: string; userId?: string; tgId?: string; tgUsername?: string }>({ name: 'Я', avatar: 'https://picsum.photos/seed/me/64/64' });
  const [gmAvatar, setGmAvatar] = useState<string>('');
  const [charAvatar, setCharAvatar] = useState<string>('');
  const [charName, setCharName] = useState<string>('Персонаж');
  const [selectedCharId, setSelectedCharId] = useState<string | null>(null);
  const [showUser, setShowUser] = useState<{ name: string; avatar: string } | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [messages, setMessages] = useState<Array<{ from: 'bot' | 'me'; text: string }>>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [recOn, setRecOn] = useState(false);
  const recRef = React.useRef<MediaRecorder | null>(null);
  const recChunksRef = React.useRef<BlobPart[]>([]);
  const [currentTurnUserId, setCurrentTurnUserId] = useState<string | null>(null);
  const [lobbyMembers, setLobbyMembers] = useState<{ userId: string; name: string; avatarUrl: string }[]>([]);
  const memberMap = useMemo(() => new Map(lobbyMembers.map((u) => [u.userId, u] as const)), [lobbyMembers]);
  const lobbyId = new URLSearchParams(location.search).get('lobby') || undefined;
  const [bgUrl, setBgUrl] = useState<string>('');
  const bgBusyRef = React.useRef<boolean>(false);
  const [engineSessionId, setEngineSessionId] = useState<string | null>(null);
  const engineLocRef = React.useRef<string | null>(null);
  const [locsForBg, setLocsForBg] = useState<Array<{ title: string; backgroundUrl?: string | null }>>([]);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = React.useRef<string | null>(null);
  const speakSeqRef = React.useRef<number>(0);
  const activeSpeakSeqRef = React.useRef<number>(0);
  const speakingInFlightRef = React.useRef<boolean>(false);
  const brokenBgSetRef = React.useRef<Set<string>>(new Set());
  const resolveAssetUrl = (u?: string | null): string => {
    const raw = String(u || '').trim();
    if (!raw) return '';
    if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:')) return raw;
    if (raw.startsWith('/uploads/')) {
      try {
        const host = window.location.hostname;
        const root = host.split('.').slice(-2).join('.');
        const base = root === 'localhost' ? 'http://localhost:4000' : `${window.location.protocol}//api.${root}`;
        return `${base}${raw}`;
      } catch {
        return raw;
      }
    }
    return raw;
  };
  const preloadImage = (url: string): Promise<boolean> => {
    return new Promise((resolve) => {
      try {
        const img = new Image();
        let done = false;
        const finish = (ok: boolean) => { if (!done) { done = true; resolve(ok); } };
        img.onload = () => finish(true);
        img.onerror = () => finish(false);
        img.src = url;
        setTimeout(() => finish(false), 8000);
      } catch { resolve(false); }
    });
  };
  const setBgFromUrl = async (raw?: string | null) => {
    const url = resolveAssetUrl(raw);
    if (!url) return;
    if (brokenBgSetRef.current.has(url)) return;
    const ok = await preloadImage(url);
    if (ok) {
      setBgUrl(url);
    } else {
      brokenBgSetRef.current.add(url);
      // eslint-disable-next-line no-console
      console.warn('[BG] missing image', url);
    }
  };
  const normalizeCyr = (s: string) => {
    const t = s.toLowerCase().replace(/[^а-яёa-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim();
    const words = t.split(' ').filter(Boolean).map((w) => {
      // грубый стемминг русских окончаний для часто встречающихся форм
      // длину >4 сокращаем, убирая типичные финальные буквы
      let x = w;
      const endings = ['иями','ями','ами','ями','его','ому','ыми','ими','ей','ой','ая','яя','ые','ие','ых','их','ую','юю','ом','ем','ах','ях','ия','ий','иям','ием','ию','иею','ии','ья','ью','ье','ьи','ия','ию','ие','ий','ой','ей','ою','ею','у','ю','а','я','е','и','ы','о'];
      for (const end of endings) {
        if (x.length > 4 && x.endsWith(end)) { x = x.slice(0, -end.length); break; }
      }
      return x;
    });
    return words.join(' ');
  };
  const applyBgFromText = (text?: string) => {
    try {
      const t = normalizeCyr(text || '');
      if (!t) return false;
      for (const loc of locsForBg) {
        const title = String(loc.title || '').trim();
        if (!title || !loc.backgroundUrl) continue;
        const normTitle = normalizeCyr(title);
        // Совпадение по фразе целиком или по словам
        const ok = t.includes(normTitle)
          || normTitle.split(' ').filter(Boolean).every((w) => t.includes(w));
        if (ok) {
          const url = resolveAssetUrl(loc.backgroundUrl);
          if (url && url !== bgUrl) {
            setBgFromUrl(url);
            return true;
          }
        }
      }
    } catch {}
    return false;
  };
  const updateBackground = async (text: string) => {
    try {
      if (!text || bgBusyRef.current) return;
      // eslint-disable-next-line no-console
      console.log('[BG] gen start', String(text).slice(0, 120));
      bgBusyRef.current = true;
      const dataUrl = await generateBackground(text, { width: 1280, height: 720 });
      // eslint-disable-next-line no-console
      console.log('[BG] gen done', { ok: Boolean(dataUrl), len: dataUrl ? dataUrl.length : 0 });
      if (dataUrl) setBgUrl(dataUrl);
    } catch {} finally { bgBusyRef.current = false; }
  };
  const describeSession = async (sid: string): Promise<string> => {
    try {
      const host = window.location.hostname;
      const root = host.split('.').slice(-2).join('.');
      const apiBase = root === 'localhost' ? 'http://localhost:4000/api' : `${window.location.protocol}//api.${root}/api`;
      const r = await fetch(`${apiBase}/engine/session/${encodeURIComponent(sid)}/describe`, { method: 'POST' });
      if (!r.ok) return '';
      const j = await r.json().catch(() => ({} as any));
      return (j && typeof j.text === 'string') ? j.text : '';
    } catch { return ''; }
  };
  const lastSpokenRef = React.useRef<string>('');
  const [settings, setSettings] = useState<{ ttsVolume: number; ttsRate: number; bgOn: boolean; bgVolume: number; muteChat: boolean }>(() => {
    try { const raw = window.localStorage.getItem('mira_settings'); const s = raw ? JSON.parse(raw) : {}; return { ttsVolume: Number(s.ttsVolume ?? 70), ttsRate: Number(s.ttsRate ?? 1.0), bgOn: Boolean(s.bgOn ?? true), bgVolume: Number(s.bgVolume ?? 100), muteChat: Boolean(s.muteChat ?? false) }; } catch { return { ttsVolume: 70, ttsRate: 1.0, bgOn: true, bgVolume: 100, muteChat: false }; }
  });
  useEffect(() => {
    const onChange = () => {
      try { const raw = window.localStorage.getItem('mira_settings'); const s = raw ? JSON.parse(raw) : {}; setSettings({ ttsVolume: Number(s.ttsVolume ?? 70), ttsRate: Number(s.ttsRate ?? 1.0), bgOn: Boolean(s.bgOn ?? true), bgVolume: Number(s.bgVolume ?? 100), muteChat: Boolean(s.muteChat ?? false) }); } catch {}
    };
    window.addEventListener('mira_settings_changed', onChange);
    window.addEventListener('storage', onChange);
    return () => { window.removeEventListener('mira_settings_changed', onChange); window.removeEventListener('storage', onChange); };
  }, []);
  // Функция для последовательного воспроизведения сегментов
  // Функция для воспроизведения прегенерированного аудио
  const speakWithAudio = async (audioUrl: string, text: string) => {
    try {
      const t = String(text || '');
      if (!t.trim()) return;
      
      console.log('[TTS-CLIENT] Using pre-generated audio for text:', t.slice(0, 100));
      const seq = ++speakSeqRef.current;
      activeSpeakSeqRef.current = seq;
      speakingInFlightRef.current = true;
      
      // Остановить предыдущее воспроизведение
      try {
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.src = '';
          audioRef.current.load();
          audioRef.current = null;
        }
        if (audioUrlRef.current) {
          URL.revokeObjectURL(audioUrlRef.current);
          audioUrlRef.current = null;
        }
      } catch {}
      
      // Создаем новый audio элемент
      const audio = new Audio(audioUrl);
      audioRef.current = audio;
      audioUrlRef.current = audioUrl;
      
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => {
          if (seq === activeSpeakSeqRef.current) {
            lastSpokenRef.current = t;
            speakingInFlightRef.current = false;
          }
          resolve();
        };
        audio.onerror = (e) => {
          console.error('[TTS-CLIENT] Audio playback error:', e);
          speakingInFlightRef.current = false;
          reject(e);
        };
        audio.play().catch(reject);
      });
    } catch (err) {
      console.error('[TTS-CLIENT] speakWithAudio error:', err);
      speakingInFlightRef.current = false;
      // НЕ делаем fallback на speak() - если прегенерированное аудио не работает, просто не озвучиваем
      // Это предотвращает повторный запрос к TTS
      console.warn('[TTS-CLIENT] Pre-generated audio failed, skipping TTS to avoid duplicate request');
    }
  };

  const speak = async (text: string, context?: { characterId?: string; locationId?: string; gender?: string; isNarrator?: boolean }) => {
    try {
      const t = String(text || '');
      if (!t.trim()) return;
      
      // Предотвращаем дубли
      if (t === lastSpokenRef.current && speakingInFlightRef.current) return;
      
      console.log('[TTS-CLIENT] Starting standalone streaming TTS for text:', t.slice(0, 100));
      const seq = ++speakSeqRef.current;
      activeSpeakSeqRef.current = seq;
      speakingInFlightRef.current = true;
      lastSpokenRef.current = t;

      // Базовая логика выбора голоса
      let voiceName = 'Aoede';
      if (context?.gender?.toLowerCase().includes('жен')) voiceName = 'Kore';
      else if (context?.gender?.toLowerCase().includes('муж')) voiceName = 'Charon';

      await playStreamingTTSChunked({
        text: t,
        voiceName: voiceName,
        modelName: 'gemini-2.0-flash-exp',
        wordsPerChunk: 40,
        onProgress: (bytes: number) => {
          // Можно обновлять UI прогресса
        },
        onComplete: () => {
          if (seq === activeSpeakSeqRef.current) {
            speakingInFlightRef.current = false;
          }
        },
        onError: (err: Error) => {
          console.error('[TTS-CLIENT] Streaming TTS error:', err);
          if (seq === activeSpeakSeqRef.current) {
            speakingInFlightRef.current = false;
          }
        }
      });
    } catch (err) {
      console.error('[TTS-CLIENT] speak() error:', err);
      speakingInFlightRef.current = false;
    }
  };
  const getDeviceIdLocal = () => {
    try {
      const key = 'mira_device_id';
      let v = window.localStorage.getItem(key) || '';
      if (!v) { v = Math.random().toString(36).slice(2) + Date.now().toString(36); window.localStorage.setItem(key, v); }
      return v;
    } catch { return 'dev'; }
  };
  // Если пришли без lobby в URL, но есть активное лобби — добавим его в URL (чтобы welcome и история шли общие)
  useEffect(() => {
    if (!lobbyId) {
      try {
        const saved = window.localStorage.getItem('mira_active_lobby_id') || '';
        if (saved) {
          getLobby(saved).then((l) => {
            if (l && l.status === 'RUNNING' && l.gameId === id) {
              navigate(`/game/${id}/chat?lobby=${encodeURIComponent(saved)}`, { replace: true });
            }
          }).catch(() => {});
        }
      } catch {}
    }
  }, [lobbyId, id, navigate]);
  useEffect(() => {
    // идентификация
    try {
      let userId: string | undefined;
      try { userId = (typeof window !== 'undefined' && window.localStorage.getItem('mira_user_id')) || undefined; } catch {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wa: any = (window as unknown as { Telegram?: unknown }).Telegram;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const u = wa?.WebApp?.initDataUnsafe?.user as { id?: number; username?: string; first_name?: string; last_name?: string; photo_url?: string } | undefined;
      const tgId = u?.id ? String(u.id) : undefined;
      const tgUsername = u?.username || undefined;
      const name = u?.username ? '@' + u.username : [u?.first_name, u?.last_name].filter(Boolean).join(' ') || 'Я';
      const avatar = u?.photo_url || 'https://picsum.photos/seed/me/64/64';
      setSelf({ name, avatar, userId, tgId, tgUsername });
    } catch {}
  }, []);
  useEffect(() => {
    // подтянуть server-side userId, если нет
    (async () => {
      try {
        if (!self.userId) {
          const p = await fetchProfile();
          setSelf((s) => ({ ...s, userId: p.id, avatar: s.avatar || p.avatarUrl }));
        }
      } catch {}
    })();
  }, [self.userId]);
  useEffect(() => {
    if (lobbyId) {
      getLobby(lobbyId).then((l) => {
        if (l) {
          setLobbyMembers((l.members || []).map((m) => ({ userId: m.userId, name: m.name, avatarUrl: m.avatarUrl })));
          if (l.currentTurnUserId) setCurrentTurnUserId(l.currentTurnUserId);
        }
      }).catch(() => {});
    }
  }, [lobbyId]);
  // Подтянуть аватары: ведущего и выбранного персонажа
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const g = await fetchGame(id);
        const chars = Array.isArray(g.characters) ? g.characters : [];
        const gm = chars.find((c) => {
          const r = String(c.role || '').toLowerCase();
          return r.includes('gm') || r.includes('ведущ') || r.includes('мастер') || r.includes('narrator') || r.includes('guide') || r.includes('директор');
        });
        let picked: typeof chars[number] | undefined;
        try {
          const selId = window.localStorage.getItem(`mira_selected_char_${id}`) || '';
          if (selId) picked = chars.find((c) => c.id === selId);
        } catch {}
        if (!picked) {
          const playable = chars.filter((c) => c.isPlayable !== false);
          picked = playable[0] || chars[0];
        }
        if (!mounted) return;
        const gmUrl = resolveAssetUrl(gm?.avatarUrl || '');
        const chUrl = resolveAssetUrl(picked?.avatarUrl || '');
        if (gmUrl) setGmAvatar(gmUrl);
        if (chUrl) setCharAvatar(chUrl);
        if (picked?.name) setCharName(picked.name);
        if (picked?.id) setSelectedCharId(picked.id);
      } catch {}
    })();
    return () => { mounted = false; };
  }, [id]);
  // Подтянуть список локаций (для эвристики установки фона по тексту)
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const list = await fetchLocations(id);
        if (mounted && Array.isArray(list)) {
          setLocsForBg(list.map((l) => ({ title: l.title, backgroundUrl: l.backgroundUrl })));
        }
      } catch {}
    })();
    return () => { mounted = false; };
  }, [id]);
  // Когда подтянулись локации или сообщения — попробуем применить фон по последнему сообщению
  useEffect(() => {
    try {
      const lastBot = [...messages].reverse().find((m: any) => m?.from === 'bot');
      if (lastBot?.text) applyBgFromText(lastBot.text);
    } catch {}
  }, [locsForBg, messages]);
  // Дублируем фон на body для WebView Telegram, чтобы исключить перекрытия стилями
  useEffect(() => {
    try {
      const baseColor = '#0b0f14';
      if (bgUrl) {
        const css = `url("${bgUrl}")`;
        document.body.style.backgroundImage = css;
        (document.body.style as any).backgroundSize = 'cover';
        document.body.style.backgroundRepeat = 'no-repeat';
        document.body.style.backgroundPosition = 'center center';
        document.body.style.backgroundColor = 'transparent';
        // html элемент
        const htmlEl = document.documentElement as HTMLElement;
        htmlEl.style.backgroundImage = css;
        (htmlEl.style as any).backgroundSize = 'cover';
        htmlEl.style.backgroundRepeat = 'no-repeat';
        htmlEl.style.backgroundPosition = 'center center';
        htmlEl.style.backgroundColor = 'transparent';
        // контейнер .screen (если есть)
        const screenEl = document.querySelector('.screen') as HTMLElement | null;
        if (screenEl) {
          screenEl.style.backgroundColor = 'transparent';
        }
      } else {
        document.body.style.backgroundImage = '';
        document.body.style.backgroundColor = baseColor;
        const htmlEl = document.documentElement as HTMLElement;
        htmlEl.style.backgroundImage = '';
        htmlEl.style.backgroundColor = baseColor;
      }
    } catch {}
    return () => {
      try {
        document.body.style.backgroundImage = '';
        const htmlEl = document.documentElement as HTMLElement;
        htmlEl.style.backgroundImage = '';
      } catch {}
    };
  }, [bgUrl]);
  // Инъекция стилей: единый фон по умолчанию, прозрачность при наличии изображения
  useEffect(() => {
    try {
      const id = 'mira-bg-style-fix';
      let tag = document.getElementById(id) as HTMLStyleElement | null;
      const baseColor = '#0b0f14';
      const css = `
        html, body, #root, .screen { background-color: ${bgUrl ? 'transparent' : baseColor} !important; height: 100%; }
        .chat { min-height: 100vh; ${bgUrl ? 'background-color: transparent !important;' : `background-color: ${baseColor} !important;`} }
        .messages { background: transparent !important; }
      `;
      if (!tag) {
        tag = document.createElement('style');
        tag.id = id;
        tag.type = 'text/css';
        tag.appendChild(document.createTextNode(css));
        document.head.appendChild(tag);
      } else {
        tag.textContent = css;
      }
    } catch {}
  }, [bgUrl]);
  // Инициализация/поллинг движка для получения фонового изображения локации
  useEffect(() => {
    let intId: number | undefined;
    (async () => {
      try {
        if (!id) return;
        // Старт/получение сессии без сброса прогресса
        let preserve = true;
        try {
          const key = `mira_reset_session_${id}`;
          const flag = window.localStorage.getItem(key);
          if (flag === '1') {
            preserve = false;
            window.localStorage.removeItem(key);
          } else if (!messages.length && !lobbyId) {
            // если истории нет в соло — начнём заново с первой локации
            preserve = false;
          }
        } catch {}
        // Проверка наличия выбранного персонажа перед стартом
        const selCharId = selectedCharId || (() => {
          try {
            return window.localStorage.getItem(`mira_selected_char_${id}`);
          } catch {
            return null;
          }
        })();
        
        if (!selCharId) {
          // Попробуем найти игрового персонажа автоматически
          try {
            const g = await fetchGame(id);
            const playable = (g.characters || []).filter((c) => c.isPlayable !== false);
            if (playable.length === 0) {
              alert('В игре нет игровых персонажей. Пожалуйста, выберите персонажа перед началом игры.');
              navigate(`/game/${id}/characters`);
              return;
            }
            const firstPlayable = playable[0];
            if (firstPlayable?.id) {
              window.localStorage.setItem(`mira_selected_char_${id}`, firstPlayable.id);
              setSelectedCharId(firstPlayable.id);
            } else {
              alert('Пожалуйста, выберите персонажа перед началом игры.');
              navigate(`/game/${id}/characters`);
              return;
            }
          } catch {
            alert('Не удалось загрузить персонажей. Пожалуйста, выберите персонажа перед началом игры.');
            navigate(`/game/${id}/characters`);
            return;
          }
        } else {
          // Проверяем, что выбранный персонаж является игровым
          try {
            const g = await fetchGame(id);
            const selectedChar = (g.characters || []).find((c) => c.id === selCharId);
            if (!selectedChar) {
              alert('Выбранный персонаж не найден. Пожалуйста, выберите персонажа заново.');
              navigate(`/game/${id}/characters`);
              return;
            }
            if (selectedChar.isPlayable === false) {
              alert('Выбранный персонаж не является игровым. Пожалуйста, выберите игрового персонажа.');
              navigate(`/game/${id}/characters`);
              return;
            }
          } catch {
            // Если не удалось проверить, продолжаем (на сервере будет проверка)
          }
        }
        
        const started = await startEngineSession({ gameId: id, lobbyId, preserve });
        setEngineSessionId(started.id);
        // Мгновенно подтянуть локацию
        try {
          const sess = await getEngineSession(started.id);
          engineLocRef.current = sess.location?.id || null;
          if (sess.location?.backgroundUrl) setBgFromUrl(sess.location.backgroundUrl);
        } catch {}
        // Поллинг актуальной локации, чтобы фон менялся при переходах
        intId = window.setInterval(async () => {
          try {
            if (!started.id) return;
            const sess = await getEngineSession(started.id);
            const locId = sess.location?.id || null;
            if (locId && locId !== engineLocRef.current) {
              engineLocRef.current = locId;
              if (sess.location?.backgroundUrl) {
                setBgFromUrl(sess.location.backgroundUrl);
              }
            } else if (sess.location?.backgroundUrl) {
              const resolved = resolveAssetUrl(sess.location.backgroundUrl);
              if (!bgUrl || resolved !== bgUrl) {
                setBgFromUrl(resolved);
              }
            }
          } catch {}
        }, 2000);
      } catch {}
    })();
    return () => { if (intId) window.clearInterval(intId); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, lobbyId]);
  useEffect(() => {
    if (!lobbyId) return;
    const rt = connectRealtime((e) => {
      if (e.type === 'turn_changed' && e.lobbyId === lobbyId) setCurrentTurnUserId(e.userId);
      if (e.type === 'lobby_started' && e.lobbyId === lobbyId && e.gameId) navigate(`/game/${e.gameId}/chat?lobby=${encodeURIComponent(lobbyId)}`);
      if ((e.type === 'lobby_member_left' || e.type === 'lobby_member_joined') && e.lobbyId === lobbyId) {
        getLobby(lobbyId).then((l) => { if (l) setLobbyMembers((l.members || []).map((m) => ({ userId: m.userId, name: m.name, avatarUrl: m.avatarUrl }))); }).catch(() => {});
      }
      if (e.type === 'chat_updated' && e.lobbyId === lobbyId) {
        getChatHistory(id, lobbyId).then((h) => {
          if (Array.isArray(h) && h.length > 0) {
            // Обновляем только если есть новые сообщения, чтобы избежать лишних обновлений
            setMessages((prev) => {
              // Проверяем, действительно ли есть изменения
              if (prev.length === h.length && prev.every((m, i) => m.text === h[i]?.text && m.from === h[i]?.from)) {
                return prev; // Нет изменений, возвращаем старое состояние
              }
              return h as any;
            });
            const lastBot = [...h].reverse().find((m: any) => m.from === 'bot');
            if (lastBot?.text) {
              speak(lastBot.text);
              applyBgFromText(lastBot.text);
            }
          }
        }).catch(() => {});
        // Подтянем текущую локацию для обновления фона
        (async () => {
          try {
            if (engineSessionId) {
              const sess = await getEngineSession(engineSessionId);
              engineLocRef.current = sess.location?.id || null;
              if (sess.location?.backgroundUrl) setBgFromUrl(sess.location.backgroundUrl);
            }
          } catch {}
        })();
      }
    });
    return () => { rt.close(); };
  }, [lobbyId, navigate, engineSessionId]);
  // Fallback-пуллинг текущего хода (на случай блокировки WS)
  useEffect(() => {
    if (!lobbyId) return;
    let t: number | undefined;
    const tick = async () => {
      try { const l = await getLobby(lobbyId); if (l && l.currentTurnUserId) setCurrentTurnUserId(l.currentTurnUserId); } catch {}
    };
    t = window.setInterval(tick, 2000);
    return () => { if (t) window.clearInterval(t); };
  }, [lobbyId]);
  // Fallback-пуллинг истории лобби
  useEffect(() => {
    if (!lobbyId) return;
    let t: number | undefined;
    const tick = async () => {
      try {
        const h = await getChatHistory(id, lobbyId);
        if (Array.isArray(h)) {
          setMessages(h as any);
          const lastBot = [...h].reverse().find((m: any) => m.from === 'bot');
          if (lastBot?.text) {
            speak(lastBot.text);
            applyBgFromText(lastBot.text);
          }
        }
      } catch {}
    };
    t = window.setInterval(tick, 2000);
    return () => { if (t) window.clearInterval(t); };
  }, [lobbyId, id]);
  const chooseRecorder = async (): Promise<MediaRecorder> => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      'audio/mpeg',
      'audio/wav',
    ];
    const picked = candidates.find((t) => (window as any).MediaRecorder && (window as any).MediaRecorder.isTypeSupported && (window as any).MediaRecorder.isTypeSupported(t));
    return picked ? new MediaRecorder(stream, { mimeType: picked }) : new MediaRecorder(stream);
  };

  const isMyTurn = (!lobbyId || (self.userId ? currentTurnUserId === self.userId : false)) && !settings.muteChat;

  const sendText = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    
    // КРИТИЧЕСКИ ВАЖНО: Останавливаем текущее воспроизведение TTS при отправке нового сообщения
    try {
      stopStreamingTTS();
      // Сбрасываем флаги воспроизведения
      speakingInFlightRef.current = false;
      activeSpeakSeqRef.current = 0;
      console.log('[TTS-CLIENT] Stopped all audio streams due to new user message');
    } catch (e) {
      console.warn('[TTS-CLIENT] Error stopping audio:', e);
    }
    
    // блок по очереди
    if (lobbyId) {
      const myId = self.userId || self.tgId || '';
      if (currentTurnUserId && myId && currentTurnUserId !== myId) {
        alert('Сейчас ход другого игрока. Подождите, пожалуйста.');
        return;
      }
    }
    // В лобби не добавляем локально "me", ждём сервер и синхронизацию истории
    if (!lobbyId) {
      const hist = [...messages, { from: 'me' as const, text: trimmed }];
      setMessages(hist);
    }
    try {
      const host = window.location.hostname;
      const root = host.split('.').slice(-2).join('.');
      const apiBase = root === 'localhost' ? 'http://localhost:4000/api' : `${window.location.protocol}//api.${root}/api`;
      const body: any = { gameId: id, userText: trimmed, history: lobbyId ? [] : messages };
      if (lobbyId) body.lobbyId = lobbyId;
      // передаем идентификацию для проверки очереди на сервере
      if (self.userId) body.userId = self.userId;
      if (self.tgId) body.tgId = self.tgId;
      if (self.tgUsername) body.tgUsername = self.tgUsername;
      if (!body.userId && !body.tgId && !body.tgUsername) body.deviceId = getDeviceIdLocal();
      setIsGenerating(true); // Показываем "генерация"
      
      // Генерируем текст, затем аудио, затем отдаем вместе
      let fullText = '';
      let audioData: any = null;
      let requestDice: any = null;
      let isFallback = false;
      
    try {
      const r = await fetch(`${apiBase}/chat/reply-stream`, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify(body) 
      });
      
      if (!r.ok) {
        setIsGenerating(false);
        if (!lobbyId) setMessages((m) => [...m, { from: 'bot' as const, text: 'Ошибка связи с сервером.' }]);
        return;
      }

      const reader = r.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = '';
      const audioContext = initAudioContext();
      const audioQueue = getAudioQueue(audioContext);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          if (!part.trim()) continue;
          
          const lines = part.split('\n');
          let event = 'message';
          let dataStr = '';

          for (const line of lines) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) dataStr = line.slice(6);
          }

          if (!dataStr) continue;
          const data = JSON.parse(dataStr);

          if (event === 'text_complete') {
            setIsGenerating(false);
            fullText = data.text;
            if (fullText) {
              setMessages((m) => {
                if (lobbyId) {
                  // В лобби режиме мы просто обновляем историю из логов позже,
                  // но для мгновенного фидбека можно добавить временное сообщение
                  return [...m, { from: 'bot', text: fullText }];
                }
                return [...m, { from: 'bot', text: fullText }];
              });
              try { applyBgFromText(fullText); } catch {}
            }
          } else if (event === 'audio_chunk') {
            // Превращаем base64 в Uint8Array и пушим в очередь с индексом сегмента
            const binary = atob(data.data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            audioQueue.push(data.index, bytes);
          } else if (event === 'error') {
            console.error('[STREAM] Server error:', data.error);
          }
        }
      }
    } catch (err) {
      console.error('[REPLY] Stream request failed:', err);
      setIsGenerating(false);
      if (!lobbyId) setMessages((m) => [...m, { from: 'bot' as const, text: 'Ошибка связи с сервером.' }]);
    }

    // После завершения стрима, если были кубики (пока в reply-stream не реализовано, но добавим позже)
    // if (requestDice) { ... }
    } catch {}
  };

  // --- Dice modal state ---
  const [diceOpen, setDiceOpen] = useState(false);
  const [diceExpr, setDiceExpr] = useState<string>('d20');
  const [diceDc, setDiceDc] = useState<string>('');
  const [diceManual, setDiceManual] = useState<string>('');
  const [dicePrefill, setDicePrefill] = useState<{ expr?: string; dc?: number; context?: string; kind?: string } | null>(null);

  const rollDiceUi = async (prefill?: { expr?: string; dc?: number; context?: string; kind?: string }) => {
    if (lobbyId && !isMyTurn) return;
    setDicePrefill(prefill || null);
    setDiceExpr(prefill?.expr || 'd20');
    setDiceDc(typeof prefill?.dc === 'number' ? String(prefill.dc) : '');
    setDiceManual('');
    setDiceOpen(true);
  };

  useEffect(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wa: any = (window as unknown as { Telegram?: unknown }).Telegram;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const u = wa?.WebApp?.initDataUnsafe?.user as { username?: string; first_name?: string; last_name?: string; photo_url?: string } | undefined;
      if (u) setSelf({ name: u.username ? '@' + u.username : [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Я', avatar: u.photo_url || self.avatar });
    } catch {}
  }, []);

  // авто-сохранение истории при каждом изменении (только соло)
  useEffect(() => {
    if (!lobbyId && messages && messages.length) {
      saveChatHistory(id, messages as any).catch(() => {});
    }
  }, [id, messages, lobbyId]);

  const welcomeLoadedRef = React.useRef<boolean>(false);
  useEffect(() => {
    // Защита от повторных запусков
    if (welcomeLoadedRef.current || messages.length > 0 || isGenerating) {
      return;
    }
    
    const run = async () => {
      // Помечаем, что загрузка началась
      welcomeLoadedRef.current = true;
      
      try {
        const hist = await getChatHistory(id, lobbyId);
        if (hist && hist.length) {
          // если первый бот-ход — «Добро пожаловать…», заменим на описание сцены
          let modified = false;
          let list: Array<{ from: 'bot' | 'me'; text: string }> = [...(hist as any)];
          const first = list.find((m) => m.from === 'bot');
          if (first && /добро пожаловать/i.test(first.text || '')) {
            try {
              // дождаться id сессии
              let tries = 0;
              while (!engineSessionId && tries < 5) { await new Promise((res) => setTimeout(res, 300)); tries++; }
              if (engineSessionId) {
                const d = await describeSession(engineSessionId);
                if (d && d.trim()) {
                  first.text = d.trim();
                  modified = true;
                }
              }
            } catch {}
            if (!modified) {
              first.text = 'Тусклый свет дрожит на стенах. Мир реагирует на ваше присутствие. Осмотритесь или выберите направление.';
              modified = true;
            }
          }
          setMessages(list as any);
          const lastBot = [...list].reverse().find((m: any) => m.from === 'bot');
          if (lastBot?.text) {
            // НЕ вызываем speak() здесь - аудио уже прегенерировано и будет использовано из ответа
            applyBgFromText(lastBot.text);
          }
          if (modified) { try { await saveChatHistory(id, list as any); } catch {} }
          return;
        }
        const host = window.location.hostname;
        const root = host.split('.').slice(-2).join('.');
        const apiBase = root === 'localhost' ? 'http://localhost:4000/api' : `${window.location.protocol}//api.${root}/api`;
        const body: any = { gameId: id };
        // Передаём идентификацию, чтобы сервер не вернул user_required
        if (self.userId) body.userId = self.userId;
        if (self.tgId) body.tgId = self.tgId;
        if (self.tgUsername) body.tgUsername = self.tgUsername;
        body.deviceId = getDeviceIdLocal();
        if (lobbyId) body.lobbyId = lobbyId;
        setIsGenerating(true); // Показываем "генерация"
        const r = await fetch(`${apiBase}/chat/welcome`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const ok = r.ok;
        let text = '';
        let isFallback = false;
        let rd: any = null;
        let preGeneratedAudio: any = null;
        try {
          const data = await r.json();
          text = (data && typeof data.message === 'string') ? data.message : '';
          isFallback = Boolean((data as any).fallback);
          rd = (data as any).requestDice;
          preGeneratedAudio = (data as any)?.audio;
        } catch {}
        setIsGenerating(false); // Скрываем "генерация"
        if (lobbyId) {
          // Для лобби НИКОГДА не создаём своё приветствие: ждём общее из сервера
          for (let i = 0; i < 6; i++) {
            const h2 = await getChatHistory(id, lobbyId);
            if (h2 && h2.length) { setMessages(h2 as any); return; }
            await new Promise((res) => setTimeout(res, 400));
          }
          // если вдруг совсем пусто, покажем заглушку без сохранения
          setMessages([{ from: 'bot', text: 'Ожидаем ведущего…' } as const]);
        } else {
          if (!ok || !text.trim()) {
            // Попробуем получить описание текущей сцены через движок
            try {
              // дождёмся инициализации сессии из другого эффекта
              let tries = 0;
              while (!engineSessionId && tries < 5) { await new Promise((res) => setTimeout(res, 300)); tries++; }
              // eslint-disable-next-line @typescript-eslint/no-unused-expressions
              engineSessionId;
            } catch {}
            try {
              if (engineSessionId) {
                const d = await describeSession(engineSessionId);
                text = (d || '').trim();
              }
            } catch {}
            if (!text.trim()) {
              text = 'Тусклый свет дрожит на стенах. Мир ждёт вашего шага. Осмотритесь или выберите направление.';
              isFallback = true;
            }
          }
          setMessages((m) => {
            const next = [...m, { from: 'bot' as const, text }];
            // Используем прегенерированное аудио, если есть
            if (preGeneratedAudio?.data) {
              const audioBlob = new Blob([Uint8Array.from(atob(preGeneratedAudio.data), c => c.charCodeAt(0))], { type: preGeneratedAudio.contentType || 'audio/wav' });
              const audioUrl = URL.createObjectURL(audioBlob);
              speakWithAudio(audioUrl, text).catch(() => speak(text));
            } else {
              try { speak(text); } catch {}
            }
            try { applyBgFromText(text); } catch {}
            if (!isFallback) saveChatHistory(id, next as any).catch(() => {});
            return next;
          });
          if (rd) {
            setTimeout(() => { rollDiceUi(rd); }, 1200);
          }
        }
      } catch {
        setMessages((m) => { const next = [...m, { from: 'bot' as const, text: 'Тусклый свет дрожит на стенах. Мир ждёт вашего шага. Осмотритесь или выберите направление.' }]; return next; });
      }
    };
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, lobbyId]);
  
  // Сбрасываем флаг при смене игры или лобби
  useEffect(() => {
    welcomeLoadedRef.current = false;
  }, [id, lobbyId]);

  const fileInputId = 'file_input_hidden';
  const voiceInputId = 'voice_file_input';

  return (
    <div className="chat" style={{ backgroundImage: bgUrl ? `url("${bgUrl}")` : undefined, backgroundSize: 'cover', backgroundPosition: 'center center', backgroundRepeat: 'no-repeat', backgroundAttachment: 'fixed', backgroundColor: bgUrl ? 'transparent' : '#0b0f14' }}>
      <div className="chat-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {charAvatar && (
            <div onClick={() => selectedCharId && navigate(`/game/${id}/character/${selectedCharId}`)} style={{ cursor: 'pointer' }}>
              <img src={charAvatar} alt="" style={{ width: 44, height: 44, borderRadius: 22, border: '2px solid var(--tg-theme-button-color)', objectFit: 'cover' }} />
            </div>
          )}
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--tg-theme-text-color)' }}>{charName || 'Персонаж'}</div>
            <button className="chip-btn" style={{ padding: '2px 8px', fontSize: 10, marginTop: 2, height: 'auto', minHeight: 0 }} onClick={() => alert('Инвентарь в разработке')}>Инвентарь</button>
          </div>
        </div>

        <div style={{ flex: 1, textAlign: 'center', padding: '0 8px' }}>
          {lobbyId ? (
            <div className="muted" style={{ fontSize: 11 }}>
              {currentTurnUserId ? `Ход: ${lobbyMembers.find((m) => m.userId === currentTurnUserId)?.name || '—'}` : 'Ожидание...'}
            </div>
          ) : (
            <div style={{ fontSize: 18, fontWeight: 700, opacity: 0.8 }}>MIRA</div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <button className="chip-btn" style={{ width: 32, height: 32, padding: 0, borderRadius: 16 }} onClick={() => navigate(`/game/${id}/menu/settings`)}>⚙️</button>
          <button className="chip-btn danger" style={{ width: 32, height: 32, padding: 0, borderRadius: 16 }} onClick={async () => {
            try {
              if (lobbyId) {
                await leaveLobby(lobbyId).catch(() => {});
              }
            } finally {
              try { window.localStorage.removeItem('mira_active_lobby_id'); } catch {}
              navigate('/finished');
            }
          }}>✕</button>
        </div>
      </div>

      <div className="messages">
        {messages.map((m, i) => {
          const isUser = (m as any).from === 'user';
          const isMine = isUser ? ((m as any).userId && ((m as any).userId === self.userId)) : (m.from === 'me');
          const otherUser = isUser ? memberMap.get((m as any).userId) : undefined;
          const avatarOther = isUser && !isMine ? (otherUser?.avatarUrl || `https://picsum.photos/seed/avatar_${(m as any).userId}/64/64`) : self.avatar;
          return (
          <div key={i} className={`msg ${isMine ? 'right' : ''}`}>
            {m.from === 'bot' && (
              <div className="avatar" onClick={() => setShowUser({ name: 'Ведущий', avatar: (gmAvatar || 'https://picsum.photos/seed/master/64/64') })}><img src={(gmAvatar || 'https://picsum.photos/seed/master/64/64')} alt="bot" /></div>
            )}
            {isUser && !isMine && (
              <div className="avatar" onClick={() => setShowUser({ name: otherUser?.name || 'Игрок', avatar: avatarOther })}><img src={avatarOther} alt="u" /></div>
            )}
            <div className={`bubble ${isMine ? 'mine' : ''}`}>{m.text}</div>
            {isMine && (
              <div className="avatar" onClick={() => setShowUser({ name: (charName || self.name), avatar: (charAvatar || self.avatar) })}><img src={(charAvatar || self.avatar)} alt="me" /></div>
            )}
          </div>
          );
        })}
        {isGenerating && (
          <div className="msg">
            <div className="avatar"><img src={(gmAvatar || 'https://picsum.photos/seed/master/64/64')} alt="bot" /></div>
            <div className="bubble" style={{ opacity: 0.7, fontStyle: 'italic' }}>Генерация...</div>
          </div>
        )}
      </div>

      <div style={{ height: 4 }} />
      {lobbyId && !isMyTurn ? (
        <div className="muted" style={{ textAlign: 'center', margin: '6px 0' }}>Сейчас ход другого игрока</div>
      ) : null}
      <div className="composer">
        <button className="icon-btn" disabled={lobbyId ? !isMyTurn : false} onClick={() => document.getElementById(fileInputId)?.click()}>📎</button>
        <button className="icon-btn" disabled={lobbyId ? !isMyTurn : false} onClick={() => rollDiceUi()}>🎲</button>
        <button
          className={`icon-btn${recOn ? ' danger' : ''}`}
          disabled={lobbyId ? !isMyTurn : false}
          onClick={async () => {
            try {
              if (lobbyId && !isMyTurn) return;
              if (!recOn) {
                const mr = await chooseRecorder();
                recChunksRef.current = [];
                mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) recChunksRef.current.push(e.data); };
                mr.onstop = async () => {
                  try {
                    const blob = new Blob(recChunksRef.current, { type: (mr as any).mimeType || 'audio/webm' });
                    let text = '';
                    if (blob.size > 0) {
                      text = await transcribeAudio(blob).catch(() => '');
                    }
                    if (text && text.trim()) {
                      await sendText(text.trim());
                    } else {
                      alert('Не удалось распознать голос. Попробуйте говорить чётче или ближе к микрофону.');
                      const input = (document.querySelector('.composer .input') as HTMLInputElement | null);
                      input?.focus();
                    }
                  } finally {
                    recChunksRef.current = [];
                  }
                };
                mr.start();
                recRef.current = mr;
                setRecOn(true);
              } else {
                recRef.current?.stop();
                recRef.current?.stream.getTracks().forEach((t) => t.stop());
                recRef.current = null;
                setRecOn(false);
              }
            } catch {
              const el = document.getElementById(voiceInputId) as HTMLInputElement | null;
              el?.click();
            }
          }}
          title={recOn ? 'Остановить запись' : 'Голосовой ввод'}
        >{recOn ? '⏹' : '🎙️'}</button>
        <input id={voiceInputId} type="file" accept="audio/*" capture style={{ display: 'none' }} onChange={async (e) => {
          try {
            const f = e.target.files?.[0];
            let text = '';
            if (f) {
              text = await transcribeAudio(f).catch(() => '');
            }
            if (text && text.trim()) {
              await sendText(text.trim());
            } else {
              alert('Не удалось распознать голос. Попробуйте выбрать другое аудио или записать снова.');
              const input = (document.querySelector('.composer .input') as HTMLInputElement | null);
              input?.focus();
            }
          } finally {
            e.currentTarget.value = '';
          }
        }} />
        <input className="input" placeholder={fileName ? `Файл: ${fileName}` : 'Сообщение'} disabled={lobbyId ? !isMyTurn : false} onKeyDown={async (e) => {
          const input = e.currentTarget;
          if (e.key === 'Enter' && input.value.trim()) {
            if (lobbyId && !isMyTurn) return;
            const text = input.value.trim();
            input.value = '';
            await sendText(text);
          }
        }} />
        <button className="btn" style={{ height: 44 }} disabled={lobbyId ? !isMyTurn : false} onClick={async () => {
          if (lobbyId && !isMyTurn) return;
          const input = (document.querySelector('.composer .input') as HTMLInputElement | null);
          if (!input || !input.value.trim()) return;
          const text = input.value.trim();
          input.value = '';
          await sendText(text);
        }}>➤</button>
      </div>

      {charAvatar && (
        <div 
          onClick={() => selectedCharId && navigate(`/game/${id}/character/${selectedCharId}`)}
          style={{ 
            position: 'fixed', 
            bottom: 80, 
            right: 16, 
            zIndex: 100,
            cursor: 'pointer',
            filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.5))',
            transition: 'transform 0.2s'
          }}
          onPointerDown={(e) => { e.currentTarget.style.transform = 'scale(0.9)'; }}
          onPointerUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
        >
          <img src={charAvatar} alt="char" style={{ width: 56, height: 56, borderRadius: 28, border: '3px solid white', objectFit: 'cover' }} />
        </div>
      )}

      <input id={fileInputId} type="file" style={{ display: 'none' }} onChange={(e) => setFileName(e.target.files?.[0]?.name || null)} />

      {showUser ? (
        <Sheet title={showUser.name} onClose={() => setShowUser(null)}>
          <div style={{ textAlign: 'center' }}>
            <img src={showUser.avatar} alt="u" width={72} height={72} style={{ borderRadius: 36 }} />
          </div>
          <div style={{ textAlign: 'center', marginTop: 6 }}>⭐ 5.0</div>
          <div className="muted" style={{ textAlign: 'center', marginTop: 8 }}>
            Описание человека, если оно есть, может быть длинным или коротким...
          </div>
        </Sheet>
      ) : null}
      {diceOpen ? (
        <Sheet title="Бросок кубиков" onClose={() => setDiceOpen(false)}>
          <div className="muted">Быстрый выбор</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            {['d6','d8','d9','d16','d20'].map((d) => (
              <button key={d} className={`chip ${diceExpr === d ? 'active' : ''}`} onClick={() => setDiceExpr(d)}>{d}</button>
            ))}
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            <input className="input" placeholder="Выражение (например: d20, 2d6+1)" value={diceExpr} onChange={(e) => setDiceExpr(e.target.value)} />
            <input className="input" placeholder="DC (опционально)" value={diceDc} onChange={(e) => setDiceDc(e.target.value.replace(/[^\d\-]/g, ''))} />
            <input className="input" placeholder="Результаты вручную через запятую (например: 12, 17)" value={diceManual} onChange={(e) => setDiceManual(e.target.value)} />
          </div>
          <div style={{ height: 8 }} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn secondary" onClick={() => setDiceOpen(false)}>Отмена</button>
            <button className="btn" onClick={async () => {
              try {
                if (lobbyId && !isMyTurn) return;
                const dcNum = diceDc.trim() ? Number(diceDc) : undefined;
                const manualTokens = diceManual.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
                const manual = manualTokens.map((s) => Number(s)).filter((n) => Number.isFinite(n));
                const payload: any = { expr: diceExpr || 'd20', dc: dcNum, kind: dicePrefill?.kind || 'check', gameId: id };
                if (dicePrefill?.context) payload.context = dicePrefill.context;
                if (manual.length > 0) payload.manualResults = manual;
                if (lobbyId) payload.lobbyId = lobbyId;
                const resp = await rollDiceApi(payload);
                if (!lobbyId) {
                  if (resp?.ok && resp.message) {
                    const txt = String(resp.message);
                    setMessages((m) => {
                      const next = [...m, { from: 'bot' as const, text: txt }];
                      // озвучиваем только последний текст
                      speak(txt);
                      return next;
                    });
                  } else if (resp?.ok && Array.isArray(resp.messages)) {
                    const arr = resp.messages as string[];
                    if (arr.length) {
                      setMessages((m) => {
                        const next = [...m, ...arr.map((t) => ({ from: 'bot' as const, text: String(t) }))];
                        // озвучиваем только последнюю фразу-наратив
                        const last = arr[arr.length - 1];
                        if (last) speak(String(last));
                        return next;
                      });
                    }
                  } else if (resp?.results?.[0]) {
                    const r = resp.results[0] as any;
                    const msg = ('picked' in r)
                      ? `🎲 Бросок: ${r.notation} → (${r.rolls[0]}, ${r.rolls[1]}) ⇒ ${r.picked}${r.mod ? (r.mod > 0 ? ` +${r.mod}` : ` ${r.mod}`) : ''} = ${r.total}`
                      : `🎲 Бросок: ${r.notation} → [${r.rolls.join(', ')}]${r.mod ? (r.mod > 0 ? ` +${r.mod}` : ` ${r.mod}`) : ''} = ${r.total}`;
                    setMessages((m) => {
                      const next = [...m, { from: 'bot' as const, text: msg }];
                      speak(msg);
                      return next;
                    });
                  } else {
                    alert('Ошибка броска кубиков');
                  }
                } else {
                  if (!resp?.ok) alert('Ошибка броска кубиков');
                }
              } finally {
                setDiceOpen(false);
              }
            }}>Бросить</button>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
};

const CharacterDetails: React.FC = () => {
  const navigate = useNavigate();
  const { id: routeId, charId } = useParams<{ id?: string; charId?: string }>();
  const id = routeId || '1';
  const [game, setGame] = useState<Awaited<ReturnType<typeof fetchGame>> | null>(null);
  const [ch, setCh] = useState<import('../../api').Character | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [editingGender, setEditingGender] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [genderValue, setGenderValue] = useState('');
  useEffect(() => {
    fetchGame(id).then((g) => {
      setGame(g);
      const playable = (g.characters || []).filter((c) => c.isPlayable !== false);
      const idx = Math.max(0, Math.min(playable.length - 1, (Number(charId) || 1) - 1));
      const char = playable[idx] || null;
      setCh(char);
      if (char) {
        setNameValue(char.name || '');
        setGenderValue(char.gender || '');
      }
    }).catch(() => {});
  }, [id, charId]);
  return (
    <Sheet title={ch?.name || 'Персонаж'} onClose={() => navigate(-1)}>
      <div className="sheet-scroll">
      <div style={{ textAlign: 'center' }}>
        <img
          src={ch?.avatarUrl ? resolveAssetUrlGlobal(ch.avatarUrl) : `https://picsum.photos/seed/char_${(charId || '1')}/300/220`}
          alt="char"
          style={{ borderRadius: 12, width: '100%', maxWidth: 300, height: 220, objectFit: 'cover', display: 'block', margin: '0 auto' }}
        />
      </div>
      <div style={{ height: 8 }} />
      <div className="muted">{[ch?.gender, ch?.race, ch?.class].filter(Boolean).join(' · ') || '—'}</div>
      <div style={{ height: 12 }} />
      
      {/* D&D Stats Grid */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
        <div className="card" style={{ padding: '8px 4px', textAlign: 'center' }}>
          <div style={{ fontSize: 10, color: 'var(--tg-theme-hint-color)' }}>HP</div>
          <div style={{ fontWeight: 600 }}>{ch?.hp}/{ch?.maxHp}</div>
        </div>
        <div className="card" style={{ padding: '8px 4px', textAlign: 'center' }}>
          <div style={{ fontSize: 10, color: 'var(--tg-theme-hint-color)' }}>AC</div>
          <div style={{ fontWeight: 600 }}>{ch?.ac}</div>
        </div>
        <div className="card" style={{ padding: '8px 4px', textAlign: 'center' }}>
          <div style={{ fontSize: 10, color: 'var(--tg-theme-hint-color)' }}>LEVEL</div>
          <div style={{ fontWeight: 600 }}>{ch?.level}</div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
        {[
          { label: 'STR', val: ch?.str },
          { label: 'DEX', val: ch?.dex },
          { label: 'CON', val: ch?.con },
          { label: 'INT', val: ch?.int },
          { label: 'WIS', val: ch?.wis },
          { label: 'CHA', val: ch?.cha },
        ].map(s => (
          <div key={s.label} className="card" style={{ padding: '8px 4px', textAlign: 'center', background: 'rgba(255,255,255,0.03)' }}>
            <div style={{ fontSize: 10, color: 'var(--tg-theme-hint-color)' }}>{s.label}</div>
            <div style={{ fontWeight: 600 }}>{s.val}</div>
            <div style={{ fontSize: 9, opacity: 0.6 }}>
              {s.val ? (Math.floor((s.val - 10) / 2) >= 0 ? `+${Math.floor((s.val - 10) / 2)}` : Math.floor((s.val - 10) / 2)) : '0'}
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ padding: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>История</div>
        <div className="muted">{ch?.description || 'Описание персонажа появится здесь.'}</div>
      </div>
      <div style={{ height: 12 }} />
      <div className="card" style={{ padding: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Настройки персонажа</div>
        <div style={{ display: 'grid', gap: 8 }}>
          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Имя персонажа</div>
            {editingName ? (
              <div style={{ display: 'flex', gap: 6 }}>
                <input 
                  className="input" 
                  value={nameValue} 
                  onChange={(e) => setNameValue(e.target.value)}
                  placeholder={ch?.name || 'Имя'}
                  style={{ flex: 1 }}
                />
                <button 
                  className="btn" 
                  onClick={async () => {
                    if (ch?.id && nameValue.trim()) {
                      try {
                        const updated = await updateCharacter(ch.id, { name: nameValue.trim() });
                        setCh(updated);
                        setEditingName(false);
                      } catch (e) {
                        alert('Не удалось сохранить имя');
                      }
                    }
                  }}
                >Сохранить</button>
                <button 
                  className="btn secondary" 
                  onClick={() => {
                    setNameValue(ch?.name || '');
                    setEditingName(false);
                  }}
                >Отмена</button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1 }}>{ch?.name || '—'}</div>
                <button className="btn secondary" onClick={() => setEditingName(true)} style={{ fontSize: 12, padding: '4px 8px' }}>Изменить</button>
              </div>
            )}
          </div>
          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Пол персонажа</div>
            {editingGender ? (
              <div style={{ display: 'flex', gap: 6 }}>
                <input 
                  className="input" 
                  value={genderValue} 
                  onChange={(e) => setGenderValue(e.target.value)}
                  placeholder={ch?.gender || 'Пол'}
                  style={{ flex: 1 }}
                />
                <button 
                  className="btn" 
                  onClick={async () => {
                    if (ch?.id) {
                      try {
                        const updated = await updateCharacter(ch.id, { gender: genderValue.trim() || null });
                        setCh(updated);
                        setEditingGender(false);
                      } catch (e) {
                        alert('Не удалось сохранить пол');
                      }
                    }
                  }}
                >Сохранить</button>
                <button 
                  className="btn secondary" 
                  onClick={() => {
                    setGenderValue(ch?.gender || '');
                    setEditingGender(false);
                  }}
                >Отмена</button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1 }}>{ch?.gender || '—'}</div>
                <button className="btn secondary" onClick={() => setEditingGender(true)} style={{ fontSize: 12, padding: '4px 8px' }}>Изменить</button>
              </div>
            )}
          </div>
        </div>
      </div>
      </div>
      <div className="sheet-footer">
      <button
        className="btn block"
        disabled={!ch?.id || ch.isPlayable === false}
        onClick={() => {
          if (!ch?.id) {
            alert('Пожалуйста, выберите персонажа перед началом игры');
            return;
          }
          if (ch.isPlayable === false) {
            alert('Выбранный персонаж не является игровым. Пожалуйста, выберите игрового персонажа.');
            return;
          }
          try { 
            window.localStorage.setItem(`mira_selected_char_${id}`, ch.id); 
          } catch {}
          navigate(`/game/${id}/chat`);
        }}
        style={{
          opacity: (!ch?.id || ch.isPlayable === false) ? 0.5 : 1,
          cursor: (!ch?.id || ch.isPlayable === false) ? 'not-allowed' : 'pointer'
        }}
      >
        {!ch?.id ? 'Выберите персонажа' : ch.isPlayable === false ? 'Выберите игрового персонажа' : 'Начать игру'}
      </button>
      </div>
    </Sheet>
  );
};

const Layout: React.FC = () => {
  const location = useLocation();
  // Мемоизируем проверку, чтобы не пересчитывать при каждом рендере
  // Навигация скрывается ТОЛЬКО на страницах игры (/game/*)
  const hideBottom = useMemo(() => /^\/game\//.test(location.pathname), [location.pathname]);
  
  return (
    <>
    <div className="screen">
      <Outlet />
    </div>
      {/* Навигация рендерится ВНЕ .screen, чтобы не перекрывалась и всегда была видна на всех страницах */}
      {!hideBottom ? <BottomNav /> : null}
    </>
  );
};

// --- Админ-панель ---
const AdminPage: React.FC = () => {
  const navigate = useNavigate();
  const mode = (() => {
    try { return ((import.meta as unknown as { env?: { MODE?: string } })?.env?.MODE) || 'prod'; } catch { return 'prod'; }
  })();
  return (
    <div>
      <h2>Админ‑панель MIRA</h2>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(1, 1fr)', gap: 10 }}>
        <div className="card" style={{ padding: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Статус</div>
          <div className="muted">Версия клиента: 1.0 · Сборка: {mode}</div>
        </div>
        <div className="card" style={{ padding: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Быстрые действия</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn secondary" onClick={() => navigate('/catalog')}>Открыть каталог</button>
            <button className="btn secondary" onClick={() => navigate('/friends')}>Список друзей</button>
          </div>
        </div>
        <div className="card" style={{ padding: 12 }}>
          <div className="muted">Здесь будет полноценная админ‑панель (пользователи, лобби, логи, настройки).</div>
        </div>
      </div>
    </div>
  );
};

const Welcome: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const hasLobby = Boolean(params.get('lobby'));
    if (hasLobby) return; // не трогаем редирект, App обработает lobby
    const registered = typeof window !== 'undefined' && window.localStorage.getItem('mira_registered') === '1';
    if (registered) {
      navigate('/catalog', { replace: true });
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wa: any = (window as unknown as { Telegram?: unknown }).Telegram;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const u = wa?.WebApp?.initDataUnsafe?.user as { id?: number } | undefined;
      const tgId = u?.id ? String(u.id) : undefined;
      if (tgId) {
        findUserByTgId(tgId).then((found) => {
          if (found) {
            try { window.localStorage.setItem('mira_registered', '1'); } catch {}
            navigate('/catalog', { replace: true });
          }
        }).catch(() => {});
      }
    } catch {}
  }, [navigate, location.search]);

  return (
    <div>
      <div style={{ textAlign: 'center', marginTop: 40 }}>
        <img src="https://picsum.photos/seed/mira_logo/120/80" alt="logo" style={{ borderRadius: 12 }} />
        <h2>Добро пожаловать в MIRA!</h2>
        <p className="muted">Тут описание, может быть длинным или коротким...</p>
        <Link to="/register" className="btn block">Продолжить</Link>
      </div>
    </div>
  );
};

const Register: React.FC = () => {
  const navigate = useNavigate();
  const [firstName, setFirstName] = useState('Валентин');
  const [lastName, setLastName] = useState('Королёв');
  const [username, setUsername] = useState('@valya');
  const [submitting, setSubmitting] = useState(false);
  const [fromTG, setFromTG] = useState<{ tgId?: string; tgUsername?: string } | null>(null);

  useEffect(() => {
    // Пытаемся достать данные из Telegram и авто-редирект, если уже зарегистрирован
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wa: any = (window as unknown as { Telegram?: unknown }).Telegram;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const u = wa?.WebApp?.initDataUnsafe?.user as { id?: number; username?: string; first_name?: string; last_name?: string } | undefined;
      if (u) {
        const tgId = u.id ? String(u.id) : undefined;
        const tgUsername = u.username ? u.username : undefined;
        setFromTG({ tgId, tgUsername });
        if (u.username) setUsername(`@${u.username}`);
        if (u.first_name) setFirstName(u.first_name);
        if (u.last_name) setLastName(u.last_name);
        if (tgId) {
          findUserByTgId(tgId).then((found) => {
            if (found) navigate('/catalog');
          }).catch(() => {});
        }
      }
    } catch {}
  }, [navigate]);

  return (
    <div>
      <div style={{ textAlign: 'center', marginTop: 24 }}>
        <img src="https://picsum.photos/seed/mira_logo/120/80" alt="logo" style={{ borderRadius: 12 }} />
        <h2>Зарегистрироваться</h2>
      </div>
      <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
        <input className="input" placeholder="Имя" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        <input className="input" placeholder="Фамилия" value={lastName} onChange={(e) => setLastName(e.target.value)} />
        <input className="input" placeholder="Никнейм" value={username} onChange={(e) => setUsername(e.target.value)} readOnly={Boolean(fromTG?.tgUsername)} />
        <button
          className="btn block"
          disabled={submitting}
          onClick={async () => {
            try {
              setSubmitting(true);
              // Попытка взять данные из Telegram WebApp
              let tgId: string | undefined = fromTG?.tgId;
              let tgUsername: string | undefined = fromTG?.tgUsername || username || undefined;
              try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const wa: any = (window as unknown as { Telegram?: unknown }).Telegram;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                const initDataUnsafe = wa?.WebApp?.initDataUnsafe as { user?: { id?: number; username?: string } } | undefined;
                if (initDataUnsafe?.user?.id) tgId = String(initDataUnsafe.user.id);
                if (initDataUnsafe?.user?.username) tgUsername = initDataUnsafe.user.username;
              } catch {}

              // Если юзер уже есть — не создаём
              if (tgId) {
                const exists = await findUserByTgId(tgId);
                if (!exists) {
                  const created = await createUser({ firstName, lastName, tgUsername, tgId });
                  try { window.localStorage.setItem('mira_user_id', String((created as any).id)); } catch {}
                } else {
                  try { window.localStorage.setItem('mira_user_id', String((exists as any).id)); } catch {}
                }
              } else {
                const created = await createUser({ firstName, lastName, tgUsername });
                try { window.localStorage.setItem('mira_user_id', String((created as any).id)); } catch {}
              }
              try { window.localStorage.setItem('mira_registered', '1'); } catch {}
            } catch (e) {
              // без всплывающих ошибок — UX
            } finally {
              setSubmitting(false);
              navigate('/subscribe');
            }
          }}
        >
          {submitting ? 'Сохраняем...' : 'Продолжить'}
        </button>
      </div>
    </div>
  );
};

const Subscribe: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const redirectTo = params.get('redirect') || '/catalog';
  const go = () => navigate(redirectTo);

  return (
    <div>
      <h2 style={{ textAlign: 'center' }}>Выберите подписку</h2>
      <div className="card" style={{ padding: 10, display: 'grid', gap: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
          <input className="input" placeholder="code" />
          <button className="btn">Применить</button>
        </div>
        <div className="muted" style={{ textAlign: 'center' }}>У меня есть промокод на пробный период</div>
      </div>
      <div style={{ height: 12 }} />

      <div style={{ display: 'grid', gap: 12 }}>
        <div className="plan disabled">
          <div className="title">Месяц</div>
          <p className="desc">Тут описание, может быть длинным или коротким, вот так выглядит, если переносится на новые строки вниз и может опускаться еще на несколько строчек.</p>
          <div className="actions">
            <button className="btn secondary" disabled>Выбрать</button>
          </div>
        </div>

        <div className="plan">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="title">6 месяцев</div>
            <span className="badge">Выгодно</span>
          </div>
          <p className="desc">Тут описание, может быть длинным или коротким, вот так выглядит, если переносится на новые строки вниз и может опускаться еще на несколько строчек.</p>
          <div className="actions">
            <button className="btn" onClick={go}>Выбрать</button>
          </div>
        </div>

        <div className="plan">
          <div className="title">12 месяцев</div>
          <p className="desc">Тут описание, может быть длинным или коротким и может опускаться еще на несколько строчек.</p>
          <div className="actions">
            <button className="btn" onClick={go}>Выбрать</button>
          </div>
        </div>
      </div>

      <div style={{ height: 12 }} />
      <button className="muted" onClick={() => navigate('/catalog')}>Пропустить</button>
    </div>
  );
};

const Catalog: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<Awaited<ReturnType<typeof fetchGames>>>([]);
  const [until, setUntil] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<string>('Все');
  const filters = ['Все', 'Популярные', 'Фэнтези', 'Командные', 'Пазл'];
  useEffect(() => {
    fetchGames()
      .then(setItems)
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    fetchProfile().then((p) => {
      setUntil(p.subscriptionUntil);
      setAvatar(p.avatarUrl);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wa: any = (window as unknown as { Telegram?: unknown }).Telegram;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const u = wa?.WebApp?.initDataUnsafe?.user as { photo_url?: string } | undefined;
        if (u?.photo_url) setAvatar(u.photo_url);
      } catch {}
    }).catch(() => {});
  }, []);
  return (
    <div>
      <div className="card" style={{ padding: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {avatar ? (
            <img src={avatar} alt="a" width={36} height={36} style={{ borderRadius: 18 }} />
          ) : (
            <div className="card" style={{ width: 36, height: 36, borderRadius: 18 }} />
          )}
        </div>
        <div className="btn gradient" style={{ height: 32, padding: '0 12px' }}>Подписка до {until ? new Date(until).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '—'}</div>
      </div>
      <div style={{ height: 10 }} />
      <div className="chip-row">
        {filters.map((f) => (
          <button key={f} className={`chip ${activeFilter === f ? 'active' : ''}`} onClick={() => setActiveFilter(f)}>{f}</button>
        ))}
      </div>
      <div style={{ height: 12 }} />
      <Link to="/gift" className="btn block" style={{ marginBottom: 12 }}>Показать подарок</Link>
      {loading ? (
        <div className="muted">Загрузка...</div>
      ) : (
        <div className="grid">
          {items
            .filter((g) => {
              if (activeFilter === 'Все') return true;
              if (activeFilter === 'Популярные') return g.rating >= 4.9;
              if (activeFilter === 'Фэнтези') return g.tags.includes('Фэнтези');
              if (activeFilter === 'Командные') return g.tags.includes('Командные');
              if (activeFilter === 'Пазл') return g.tags.includes('Пазл');
              return true;
            })
            .map((g) => (
            <Link to={`/game/${g.id}`} key={g.id} className="game-card">
              <img src={g.coverUrl} alt="game" />
              <div className="game-card-title">{g.title}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
};

const GameDetails: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [game, setGame] = useState<Awaited<ReturnType<typeof fetchGame>> | null>(null);
  const { id: routeId } = useParams<{ id?: string }>();
  const id = routeId || '1';
  useEffect(() => {
    fetchGame(id)
      .then(setGame)
      .finally(() => setLoading(false));
  }, [id]);
  if (loading || !game) return <div className="muted">Загрузка...</div>;
  return (
    <div>
      <h2>{game.title}</h2>
      <div className="gallery">
        <img src={game.coverUrl} alt="cover" style={{ width: '100%', height: 180, objectFit: 'cover', display: 'block' }} />
      </div>
      <div className="thumbs">
        {(game.gallery.length ? game.gallery : [game.coverUrl]).map((src, i) => (
          <img key={i} src={src} alt="thumb" />
        ))}
      </div>
      <div style={{ height: 8 }} />
      <div className="tags">
        {game.tags.map((t) => (
          <span className="tag" key={t}>{t}</span>
        ))}
      </div>
      <p className="muted">{game.description}</p>
      <div className="card" style={{ padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div className="muted">Автор</div>
          <div>{game.author} ✓</div>
        </div>
        <div className="muted">Рейтинг: {game.rating.toFixed(1)}</div>
      </div>
      <div style={{ height: 12 }} />
      <div style={{ display: 'grid', gap: 10 }}>
        <Link to={`/game/${id}/editions`} className="btn block">Купить</Link>
        <Link to={`/game/${id}/menu`} className="btn secondary block">Открыть меню</Link>
      </div>
    </div>
  );
};

const GameEditions: React.FC = () => {
  const [game, setGame] = useState<Awaited<ReturnType<typeof fetchGame>> | null>(null);
  const { id: routeId } = useParams<{ id?: string }>();
  const id = routeId || '1';
  useEffect(() => {
    if (id) fetchGame(id).then(setGame);
  }, [id]);
  if (!game) return <div className="muted">Загрузка...</div>;
  return (
    <div>
      <h2>{game.title}</h2>
      {game.editions.map((e) => (
        <div key={e.id} className="card" style={{ padding: 12, marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 600 }}>{e.name}</div>
              <div className="muted">{e.description}</div>
            </div>
            <div>{e.price} ₽</div>
          </div>
        </div>
      ))}
      <Link to={`/game/${id}/checkout`} className="btn block">Купить</Link>
    </div>
  );
};

const Checkout: React.FC = () => {
  const [delivery, setDelivery] = useState<'cdek' | 'wb' | 'ozon'>('cdek');
  const { id: routeId } = useParams<{ id?: string }>();
  const id = routeId || '1';
  const [game, setGame] = useState<Awaited<ReturnType<typeof fetchGame>> | null>(null);
  useEffect(() => { fetchGame(id).then(setGame).catch(() => setGame(null)); }, [id]);
  return (
    <div>
      <h2>{game?.title || 'Игра'}</h2>
      <div className="muted">Оформление покупки</div>
      <div className="card" style={{ padding: 12, marginTop: 10 }}>
        <div>Тип — Стандартное издание</div>
        <div style={{ height: 10 }} />
        <div className="muted">Способ доставки</div>
        <div style={{ display: 'grid', gap: 8, marginTop: 6 }}>
          <button className={`option ${delivery === 'cdek' ? 'selected' : ''}`} onClick={() => setDelivery('cdek')}>
            <span className="box">{delivery === 'cdek' ? '✓' : ''}</span>
            <span>СДЭК</span>
          </button>
          <button className={`option ${delivery === 'wb' ? 'selected' : ''}`} onClick={() => setDelivery('wb')}>
            <span className="box">{delivery === 'wb' ? '✓' : ''}</span>
            <span>Wildberries</span>
          </button>
          <button className={`option ${delivery === 'ozon' ? 'selected' : ''}`} onClick={() => setDelivery('ozon')}>
            <span className="box">{delivery === 'ozon' ? '✓' : ''}</span>
            <span>OZON</span>
          </button>
        </div>
      </div>
      <div style={{ height: 12 }} />
      <button className="btn block">Купить</button>
    </div>
  );
};

// --- Модалки и меню ---

const Sheet: React.FC<{ title?: string; onClose?: () => void; children: React.ReactNode }> = ({ title, onClose, children }) => {
  return (
    <div className="modal-sheet">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        <button className="header-btn" onClick={onClose}>✕</button>
      </div>
      <div style={{ height: 10 }} />
      {children}
    </div>
  );
};

const GiftModal: React.FC = () => {
  const navigate = useNavigate();
  return (
    <Sheet title="У вас есть подарок" onClose={() => navigate(-1)}>
      <div style={{ textAlign: 'center' }}>
        <img src="https://picsum.photos/seed/gift/220/120" alt="gift" style={{ borderRadius: 12 }} />
      </div>
      <div style={{ height: 12 }} />
      <button className="btn block" onClick={() => navigate(-1)}>Забрать</button>
    </Sheet>
  );
};

const RulesModal: React.FC = () => {
  const navigate = useNavigate();
  const { id: routeId } = useParams<{ id?: string }>();
  const id = routeId || '1';
  const speeds = [0.2, 0.5, 1.0, 1.5, 2.0];
  const [active, setActive] = useState<number>(1.0);
  const [rulesText, setRulesText] = useState<string>('');

  useEffect(() => {
    fetchGame(id).then((g) => {
      const parts = [g.rules, g.worldRules, g.gameplayRules].filter((s) => Boolean(s && String(s).trim().length)).map((s) => String(s));
      setRulesText(parts.join('\n\n'));
    }).catch(() => setRulesText(''));
  }, [id]);

  return (
    <Sheet title="Правила игры" onClose={() => navigate(-1)}>
      <div className="sheet-scroll">
        <button className="btn secondary block">Слушать правила ▶</button>
        <div className="muted">Скорость чтения</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {speeds.map((s) => (
            <button key={s} className={`btn ${active === s ? '' : 'secondary'}`} style={{ height: 36 }} onClick={() => setActive(s)}>
              {s.toFixed(1)}x
            </button>
          ))}
        </div>
        <div className="muted" style={{ display: 'grid', gap: 10 }}>
          {(rulesText ? rulesText.split(/\n{2,}/) : ['Правила пока не заполнены.']).map((paragraph, i) => (
            <p key={i} style={{ margin: 0 }}>{paragraph}</p>
          ))}
        </div>
      </div>
      <div className="sheet-footer">
        <button className="btn block" onClick={() => navigate(`/game/${id}/new`)}>Понятно</button>
      </div>
    </Sheet>
  );
};

const SettingsModal: React.FC = () => {
  const navigate = useNavigate();
  const { id: routeId } = useParams<{ id?: string }>();
  const gameId = routeId || '';
  const loadSettings = () => {
    try {
      const raw = window.localStorage.getItem('mira_settings');
      const s = raw ? JSON.parse(raw) as { ttsVolume?: number; ttsRate?: number; bgOn?: boolean; bgVolume?: number; muteChat?: boolean } : {};
      return {
        ttsVolume: Math.min(100, Math.max(0, Number(s.ttsVolume ?? 70))),
        ttsRate: Number(s.ttsRate ?? 1.0),
        bgOn: Boolean(s.bgOn ?? true),
        bgVolume: Math.min(100, Math.max(0, Number(s.bgVolume ?? 100))),
        muteChat: Boolean(s.muteChat ?? false),
      };
    } catch { return { ttsVolume: 70, ttsRate: 1.0, bgOn: true, bgVolume: 100, muteChat: false }; }
  };
  const initial = loadSettings();
  const [voice, setVoice] = useState(initial.ttsVolume);
  const [bgOn, setBgOn] = useState(initial.bgOn);
  const [bgVol, setBgVol] = useState(initial.bgVolume);
  const [muteChat, setMuteChat] = useState(initial.muteChat);

  return (
    <Sheet title="Настройки" onClose={() => navigate(-1)}>
      <div>
        <div>Громкость голоса ведущего: {voice}%</div>
        <input type="range" min={0} max={100} value={voice} onChange={(e) => setVoice(Number(e.target.value))} style={{ width: '100%' }} />
        <div style={{ height: 8 }} />
        <div>Фоновая музыка {bgOn ? 'вкл' : 'выкл'}</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={bgOn} onChange={(e) => setBgOn(e.target.checked)} /> Включить
        </label>
        <div>Громкость фоновой музыки: {bgVol}%</div>
        <input type="range" min={0} max={100} value={bgVol} onChange={(e) => setBgVol(Number(e.target.value))} style={{ width: '100%' }} />
        <div style={{ height: 8 }} />
        <div>Скорость чтения</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          {[0.2, 0.5, 1.0, 1.5, 2.0].map((s) => (
            <button key={s} className={`btn ${initial.ttsRate === s ? '' : 'secondary'}`} style={{ height: 36 }} onClick={() => { initial.ttsRate = s; }}>
              {s.toFixed(1)}x
            </button>
          ))}
        </div>
        <div style={{ height: 8 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={muteChat} onChange={(e) => setMuteChat(e.target.checked)} /> Отключить чат (оставить голос)
        </label>
      </div>
      <div style={{ height: 12 }} />
      <button className="btn block" onClick={() => {
        try {
          const settings = { ttsVolume: voice, ttsRate: initial.ttsRate, bgOn, bgVolume: bgVol, muteChat };
          window.localStorage.setItem('mira_settings', JSON.stringify(settings));
          window.dispatchEvent(new Event('mira_settings_changed'));
        } catch {}
        navigate(-1);
      }}>Сохранить</button>
      <div style={{ height: 8 }} />
      <button className="btn danger block" onClick={async () => {
        if (!gameId) { navigate(-1); return; }
        if (!confirm('Сбросить прогресс по этой игре? Это удалит текущую сцену и историю.')) return;
        try {
          const host = window.location.hostname;
          const root = host.split('.').slice(-2).join('.');
          const apiBase = root === 'localhost' ? 'http://localhost:4000/api' : `${window.location.protocol}//api.${root}/api`;
          const lobbyId = new URLSearchParams(window.location.search).get('lobby') || undefined;
          await fetch(`${apiBase}/engine/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gameId, lobbyId }) });
        } catch {}
        try { await resetChatHistory(gameId); } catch {}
        try { window.localStorage.setItem(`mira_reset_session_${gameId}`, '1'); } catch {}
        navigate(`/game/${gameId}/new`);
      }}>Сбросить игру</button>
    </Sheet>
  );
};

const GameMenu: React.FC = () => {
  const navigate = useNavigate();
  const { id: routeId } = useParams<{ id?: string }>();
  const id = routeId || '1';
  const [hasSave, setHasSave] = useState(false);
  const [game, setGame] = useState<Awaited<ReturnType<typeof fetchGame>> | null>(null);
  const ensureSubscribed = async () => {
    try {
      const p = await fetchProfile();
      const ok = p.subscriptionUntil && new Date(p.subscriptionUntil).getTime() > Date.now();
      if (!ok) {
        navigate(`/subscribe?redirect=${encodeURIComponent(`/game/${id}/characters`)}`);
        return false;
      }
      return true;
    } catch {
      return true;
    }
  };
  useEffect(() => { getChatHistory(id).then((h) => setHasSave((h || []).length > 0)); }, [id]);
  useEffect(() => { fetchGame(id).then(setGame).catch(() => setGame(null)); }, [id]);
  return (
    <div>
      <h2>{game?.title || 'Игра'}</h2>
      <p className="muted">{game?.description || 'Описание игры, может быть длинным или коротким, переносится на несколько строк.'}</p>
      <div style={{ display: 'grid', gap: 10 }}>
        <button className="btn block" onClick={async () => {
          if (await ensureSubscribed()) {
            try { await resetChatHistory(id); } catch {}
            try { window.localStorage.setItem(`mira_reset_session_${id}`, '1'); } catch {}
            navigate('rules');
          }
        }}>Новая игра</button>
        <button className="btn success block" onClick={() => navigate(`/game/${id}/chat`)}>Продолжить</button>
        <Link to="rules" className="btn secondary block">Правила игры</Link>
        <Link to="settings" className="btn secondary block">Настройки ⚙</Link>
        <button className="btn danger block">Выход ⎋</button>
      </div>
    </div>
  );
};

const ChooseModeModal: React.FC = () => {
  const navigate = useNavigate();
  const { id: routeId } = useParams<{ id?: string }>();
  const id = routeId || '1';
  const [team, setTeam] = useState<'solo' | 'team'>('solo');
  const [game, setGame] = useState<Awaited<ReturnType<typeof fetchGame>> | null>(null);
  useEffect(() => { fetchGame(id).then(setGame).catch(() => setGame(null)); }, [id]);
  return (
    <Sheet title={game?.title || 'Игра'} onClose={() => navigate(-1)}>
      <div className="muted">Выберите с кем будете играть.</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className={`btn ${team === 'solo' ? '' : 'secondary'}`} onClick={() => setTeam('solo')}>Один</button>
        <button className={`btn ${team === 'team' ? '' : 'secondary'}`} onClick={() => setTeam('team')}>С командой</button>
      </div>
      <div style={{ height: 12 }} />
      <button className="btn block" onClick={() => navigate(team === 'solo' ? `/game/${id}/characters` : `/game/${id}/new/team-code`)}>Продолжить</button>
    </Sheet>
  );
};

const TeamCodeModal: React.FC = () => {
  const navigate = useNavigate();
  const { id: routeId } = useParams<{ id?: string }>();
  const id = routeId || '1';
  const [game, setGame] = useState<Awaited<ReturnType<typeof fetchGame>> | null>(null);
  useEffect(() => { fetchGame(id).then(setGame).catch(() => setGame(null)); }, [id]);
  const [friendsList, setFriendsList] = useState<Awaited<ReturnType<typeof fetchFriends>>>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  useEffect(() => { fetchFriends().then(setFriendsList).catch(() => setFriendsList([])); }, []);
  const toggle = (id2: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id2)) next.delete(id2); else if (next.size < 3) next.add(id2);
      return next;
    });
  };
  return (
    <Sheet title={`${game?.title || 'Игра'} — Командная игра`} onClose={() => navigate(-1)}>
      <div className="muted">Выберите до 3 друзей для приглашения.</div>
      <div style={{ height: 8 }} />
      <div className="grid" style={{ gridTemplateColumns: 'repeat(1, 1fr)', gap: 8 }}>
        {friendsList.map((f) => (
          <button key={f.id} className={`option ${picked.has(f.id) ? 'selected' : ''}`} onClick={() => toggle(f.id)}>
            <span className="box">{picked.has(f.id) ? '✓' : ''}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <img src={f.avatarUrl} alt="a" width={28} height={28} style={{ borderRadius: 14 }} />
              {f.name}
            </span>
          </button>
        ))}
      </div>
      <div style={{ height: 12 }} />
      <button className="btn block" disabled={creating || picked.size === 0} onClick={async () => {
        try {
          setCreating(true);
          const lob = await createLobby({ gameId: id, maxPlayers: 4 });
          if (picked.size) await inviteToLobby(lob.id, Array.from(picked));
          try { window.localStorage.setItem('mira_active_lobby_id', lob.id); } catch {}
          navigate(`/lobby/${lob.id}`);
        } catch {
          alert('Не удалось создать лобби или отправить приглашения.');
        } finally {
          setCreating(false);
        }
      }}>Пригласить</button>
    </Sheet>
  );
};

const LobbyPage: React.FC = () => {
  const { id: lobbyId } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const [lobby, setLobby] = useState<Awaited<ReturnType<typeof getLobby>> | null>(null);
  const [game, setGame] = useState<Awaited<ReturnType<typeof fetchGame>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [inviting, setInviting] = useState(false);
  const [friendsList, setFriendsList] = useState<Awaited<ReturnType<typeof fetchFriends>>>([]);
  const [selectOpen, setSelectOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const l = lobbyId ? await getLobby(lobbyId) : null;
      setLobby(l || null);
      try { if (lobbyId) window.localStorage.setItem('mira_active_lobby_id', lobbyId); } catch {}
      if (l?.gameId) fetchGame(l.gameId).then(setGame).catch(() => setGame(null));
      setLoading(false);
    };
    load();
  }, [lobbyId]);
  useEffect(() => { fetchFriends().then(setFriendsList).catch(() => setFriendsList([])); }, []);
  useEffect(() => {
    const rt = connectRealtime((e) => {
      if (!lobbyId) return;
      if (e.type === 'lobby_member_joined' || e.type === 'lobby_member_left' || e.type === 'lobby_started') {
        getLobby(lobbyId).then(setLobby).catch(() => {});
        if (e.type === 'lobby_started' && e.gameId) navigate(`/game/${e.gameId}/chat?lobby=${encodeURIComponent(lobbyId)}`);
      }
    });
    return () => { rt.close(); };
  }, [lobbyId, navigate, lobby?.gameId]);
  // Fallback-пуллинг, если WS недоступен через прокси
  useEffect(() => {
    if (!lobbyId) return;
    let t: number | undefined;
    const tick = async () => {
      try {
        const l = await getLobby(lobbyId);
        if (l) {
          setLobby(l);
          if (l.status === 'RUNNING' && l.gameId) navigate(`/game/${l.gameId}/chat?lobby=${encodeURIComponent(lobbyId)}`);
        }
      } catch {}
    };
    t = window.setInterval(tick, 2500);
    return () => { if (t) window.clearInterval(t); };
  }, [lobbyId]);
  const meIsHost = Boolean(lobby && lobby.hostUserId && (lobby.members || []).some((m) => m.userId === lobby.hostUserId));
  if (loading) return <div className="muted">Загрузка лобби...</div>;
  if (!lobby) return <div className="muted">Лобби не найдено</div>;
  return (
    <div>
      <h2>{game?.title || 'Лобби'}</h2>
      <div className="muted">Статус: {lobby.status === 'OPEN' ? 'Ожидание игроков' : lobby.status === 'RUNNING' ? 'Идёт игра' : 'Закрыто'}</div>
      <div style={{ height: 10 }} />
      <div className="card" style={{ padding: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Участники</div>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(1, 1fr)', gap: 8 }}>
          {(lobby.members || []).map((m) => (
            <div key={m.userId} className="row-link" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <img src={m.avatarUrl} alt="a" width={28} height={28} style={{ borderRadius: 14 }} />
                <div>{m.name} {m.role === 'HOST' ? '👑' : ''}</div>
              </div>
              {meIsHost && m.role !== 'HOST' ? (
                <button className="header-btn danger" onClick={async () => {
                  try { if (!lobbyId) return; await kickFromLobby(lobbyId, m.userId); const nl = await getLobby(lobbyId); setLobby(nl); } catch {} 
                }}>Удалить</button>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      <div style={{ height: 10 }} />
      <div className="card" style={{ padding: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Приглашённые</div>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(1, 1fr)', gap: 8 }}>
          {(lobby.invited || []).length ? (lobby.invited || []).map((u) => (
            <div key={u.userId} className="row-link" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <img src={u.avatarUrl} alt="a" width={28} height={28} style={{ borderRadius: 14 }} />
                <div>{u.name}</div>
              </div>
              {meIsHost ? (
                <button className="header-btn" onClick={async () => { try { if (!lobbyId) return; await reinviteToLobby(lobbyId, u.userId); alert('Приглашение отправлено'); } catch {} }}>Пригласить заново</button>
              ) : null}
            </div>
          )) : (<div className="muted">—</div>)}
        </div>
        {meIsHost ? (
          <>
            <div style={{ height: 10 }} />
            <button className="btn secondary block" onClick={() => { setSelectOpen(true); }}>Пригласить ещё</button>
          </>
        ) : null}
      </div>
      <div style={{ height: 12 }} />
      <div style={{ display: 'grid', gap: 10 }}>
        {meIsHost ? (
          <button className="btn block" onClick={async () => { try { if (!lobbyId) return; const st = await startLobby(lobbyId); if (st.gameId) navigate(`/game/${st.gameId}/chat?lobby=${encodeURIComponent(lobbyId)}`); } catch { alert('Не удалось начать игру'); } }}>Начать игру</button>
        ) : null}
        <button className="btn secondary block" onClick={async () => {
          try {
            if (lobbyId) await leaveLobby(lobbyId).catch(() => {});
          } finally {
            try { window.localStorage.removeItem('mira_active_lobby_id'); } catch {}
            navigate('/catalog');
          }
        }}>Выйти в каталог</button>
      </div>

      {selectOpen ? (
        <Sheet title="Пригласить друзей" onClose={() => setSelectOpen(false)}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(1, 1fr)', gap: 8 }}>
            {friendsList.map((f) => (
              <button key={f.id} className={`option ${picked.has(f.id) ? 'selected' : ''}`} onClick={() => setPicked((prev) => { const n = new Set(prev); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n; })}>
                <span className="box">{picked.has(f.id) ? '✓' : ''}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <img src={f.avatarUrl} alt="a" width={28} height={28} style={{ borderRadius: 14 }} />
                  {f.name}
                </span>
              </button>
            ))}
          </div>
          <div style={{ height: 10 }} />
          <button className="btn block" disabled={inviting || picked.size === 0} onClick={async () => {
            if (!lobbyId) return;
            try { setInviting(true); await inviteToLobby(lobbyId, Array.from(picked)); const nl = await getLobby(lobbyId); setLobby(nl); setPicked(new Set()); setSelectOpen(false); } catch { alert('Не удалось отправить приглашения'); } finally { setInviting(false); }
          }}>Пригласить</button>
        </Sheet>
      ) : null}
    </div>
  );
};

const Characters: React.FC = () => {
  const navigate = useNavigate();
  const { id: routeId } = useParams<{ id?: string }>();
  const id = routeId || '1';
  const [game, setGame] = useState<Awaited<ReturnType<typeof fetchGame>> | null>(null);
  const [list, setList] = useState<import('../../api').Character[]>([]);
  useEffect(() => {
    fetchGame(id).then((g) => {
      setGame(g);
      const playable = (g.characters || []).filter((c) => c.isPlayable !== false);
      setList(playable.length ? playable : (g.characters || []));
    }).catch(() => {});
  }, [id]);
  return (
    <div>
      <h2>{game?.title || 'Игра'}</h2>
      <div className="muted">Выберите персонажа.</div>
      <div style={{ height: 10 }} />
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {list.map((c, i) => (
          <div key={c.id || i} className="card" style={{ overflow: 'hidden', cursor: 'pointer' }} onClick={() => navigate(`/game/${id}/character/${i + 1}`)}>
            <img src={resolveAssetUrlGlobal(c.avatarUrl)} alt="char" style={{ width: '100%', height: 120, objectFit: 'cover', display: 'block' }} />
            <div style={{ padding: 8 }}>
              <div>{c.name}</div>
              <div className="muted">{[c.gender, c.race].filter(Boolean).join(' · ')}</div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ height: 12 }} />
      <button className="btn block" onClick={() => navigate(-1)}>Назад</button>
    </div>
  );
};

const Routes: RouteObject[] = [
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Welcome /> },
      { path: 'register', element: <Register /> },
      { path: 'subscribe', element: <Subscribe /> },
      { path: 'catalog', element: <Catalog /> },
      { path: 'my', element: <Catalog /> },
      { path: 'friends', element: <Friends /> },
      { path: 'profile', element: <Profile /> },
      { path: 'game/:id', element: <GameDetails /> },
      { path: 'game/:id/editions', element: <GameEditions /> },
      { path: 'game/:id/checkout', element: <Checkout /> },
      { path: 'game/:id/menu', element: <GameMenu /> },
      { path: 'game/:id/menu/rules', element: <RulesModal /> },
      { path: 'game/:id/menu/settings', element: <SettingsModal /> },
      { path: 'game/:id/new', element: <ChooseModeModal /> },
      { path: 'game/:id/new/team-code', element: <TeamCodeModal /> },
      { path: 'game/:id/characters', element: <Characters /> },
      { path: 'game/:id/character/:charId', element: <CharacterDetails /> },
      { path: 'game/:id/chat', element: <GameChat /> },
      { path: 'lobby/:id', element: <LobbyPage /> },
      { path: 'gift', element: <GiftModal /> },
      { path: 'finished', element: <GameFinished /> },
      { path: 'admin', element: <AdminPage /> },
    ],
  },
];

export const App: React.FC = () => {
  const routes = useRoutes(Routes);
  const [invite, setInvite] = useState<{ lobbyId: string; expiresAt: string; gameId?: string } | null>(null);
  const [left, setLeft] = useState(30);
  const location = useLocation();
  const navigate = useNavigate();
  const [activeLobbyId, setActiveLobbyId] = useState<string | null>(null);
  useEffect(() => {
    // вычислить активное лобби из URL
    const params = new URLSearchParams(location.search);
    const qLobby = params.get('lobby');
    let pLobby: string | null = null;
    const m = /^\/lobby\/([A-Za-z0-9-]+)/.exec(location.pathname);
    if (m) pLobby = m[1] ?? null;
    const next = qLobby || pLobby;
    // Обновляем только если значение действительно изменилось
    setActiveLobbyId((prev) => {
      if (prev === next) return prev;
    try { if (next) window.localStorage.setItem('mira_active_lobby_id', next); } catch {}
      return next;
    });
  }, [location.pathname, location.search]);
  const lobbyInitializedRef = React.useRef<boolean>(false);
  useEffect(() => {
    // начальная инициализация из localStorage, если нет в URL — но только если лобби ещё актуально (проверим членство)
    // Защита от повторных запусков
    if (lobbyInitializedRef.current || activeLobbyId) {
      return;
    }
    lobbyInitializedRef.current = true;
    
    (async () => {
        try {
          const saved = window.localStorage.getItem('mira_active_lobby_id') || '';
          if (saved) {
            const my = await getMyLobbies().catch(() => []);
            const exists = Array.isArray(my) && my.some((l) => l.id === saved);
            if (exists) setActiveLobbyId(saved);
            else window.localStorage.removeItem('mira_active_lobby_id');
          }
        } catch {}
    })();
  }, [activeLobbyId]);
  
  // Сбрасываем флаг при смене location
  useEffect(() => {
    lobbyInitializedRef.current = false;
  }, [location.pathname]);
  const lobbyProcessedRef = React.useRef<string | null>(null);
  useEffect(() => {
    // deep-link ?lobby=<id>
    const params = new URLSearchParams(location.search);
    const lobId = params.get('lobby');
    // Обрабатываем только если мы НЕ на страницах лобби/игры и еще не обрабатывали этот лобби
    if (lobId && !/^\/(lobby|game)\//.test(location.pathname) && lobbyProcessedRef.current !== lobId) {
      lobbyProcessedRef.current = lobId;
      (async () => {
        try {
          await joinLobby(lobId).catch(() => {});
          navigate(`/lobby/${lobId}`, { replace: true });
        } catch {}
      })();
    } else if (!lobId) {
      // Сбрасываем флаг, если лобби нет в URL
      lobbyProcessedRef.current = null;
    }
  }, [location.search, location.pathname, navigate]);
  useEffect(() => {
    const rt = connectRealtime((e) => {
      if (e.type === 'lobby_invite') {
        setInvite({ lobbyId: e.lobbyId, expiresAt: e.expiresAt, gameId: e.gameId });
      } else if (e.type === 'lobby_started' && e.gameId) {
        // событие отправляется только участникам лобби → можно переводить всегда
        navigate(`/game/${e.gameId}/chat?lobby=${encodeURIComponent(e.lobbyId)}`);
      }
    });
    return () => { rt.close(); };
  }, [navigate]); // Убираем activeLobbyId из зависимостей, так как он не используется в эффекте
  // Глобальный fallback-пуллинг ТОЛЬКО по активному лобби
  useEffect(() => {
    if (!activeLobbyId) return;
    let t: number | undefined;
    const tick = async () => {
      try {
        const l = await getLobby(activeLobbyId);
        if (l && l.status === 'RUNNING' && l.gameId) {
          navigate(`/game/${l.gameId}/chat?lobby=${encodeURIComponent(activeLobbyId)}`);
        }
      } catch {}
    };
    t = window.setInterval(tick, 3000);
    return () => { if (t) window.clearInterval(t); };
  }, [activeLobbyId, navigate]);
  // убран глобальный принудительный редирект, чтобы не уводить в случайные лобби
  useEffect(() => {
    let t: number | undefined;
    if (invite) {
      const tick = () => {
        const ms = Math.max(0, new Date(invite.expiresAt).getTime() - Date.now());
        setLeft(Math.ceil(ms / 1000));
        if (ms <= 0) setInvite(null);
      };
      tick();
      t = window.setInterval(tick, 1000);
    }
    return () => { if (t) window.clearInterval(t); };
  }, [invite]);
  return (
    <>
      {routes}
      {invite ? (
        <Sheet title="Приглашение в игру" onClose={() => setInvite(null)}>
          <div className="muted">Вас пригласили в игру. Время на принятие: {left} сек.</div>
          <div style={{ height: 12 }} />
          <button className="btn block" onClick={async () => {
            try {
              await joinLobby(invite.lobbyId);
              try { window.localStorage.setItem('mira_active_lobby_id', invite.lobbyId); } catch {}
              navigate(`/lobby/${invite.lobbyId}`);
            } catch {
              alert('Не удалось присоединиться. Приглашение могло истечь.');
            }
          }}>Принять приглашение</button>
        </Sheet>
      ) : null}
    </>
  );
};

// --- Профиль ---
function Profile(): JSX.Element {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchProfile>> | null>(null);
  const [tg, setTg] = useState<{ username?: string; firstName?: string; lastName?: string; photoUrl?: string } | null>(null);
  useEffect(() => { fetchProfile().then(setData); }, []);
  useEffect(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wa: any = (window as unknown as { Telegram?: unknown }).Telegram;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const u = wa?.WebApp?.initDataUnsafe?.user as { username?: string; first_name?: string; last_name?: string; photo_url?: string } | undefined;
      if (u) setTg({ username: u.username, firstName: u.first_name, lastName: u.last_name, photoUrl: u.photo_url });
    } catch {}
  }, []);
  if (!data) return <div className="muted">Загрузка...</div>;
  const displayName = tg?.username ? `@${tg.username}` : [tg?.firstName, tg?.lastName].filter(Boolean).join(' ') || data.name;
  const displayAvatar = tg?.photoUrl || data.avatarUrl;
  const hasCard = Boolean(data.cardMasked && /\*/.test(data.cardMasked));
  const formatMoney = (n: number) => n.toLocaleString('ru-RU');
  return (
    <div>
      {/* Верхняя карточка: аватар и плашка подписки справа */}
      <div className="card" style={{ padding: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src={displayAvatar} alt="a" width={48} height={48} style={{ borderRadius: 24 }} />
          <div style={{ fontWeight: 600 }}>{displayName}</div>
        </div>
        <div className="btn gradient" style={{ height: 36, padding: '0 14px' }}>Подписка до {new Date(data.subscriptionUntil).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}</div>
      </div>

      <div style={{ height: 12 }} />

      {/* Статистика */}
      <div className="card" style={{ padding: 12 }}>
        <div className="stat-cards">
          <div className="card" style={{ padding: 10 }}>
            <div className="muted" style={{ fontSize: 12 }}>Всего заработано</div>
            <div style={{ fontWeight: 700 }}>{formatMoney(data.totalEarned)} ₽</div>
          </div>
          <div className="card" style={{ padding: 10 }}>
            <div className="muted" style={{ fontSize: 12 }}>Всего друзей</div>
            <div style={{ fontWeight: 700 }}>{formatMoney(data.totalFriends)}</div>
          </div>
          <button className="pill">Вывести</button>
        </div>
      </div>

      <div style={{ height: 12 }} />

      <div className="list-card card">
        <div className="card" style={{ padding: 10, textAlign: 'center' }}>Подписка до {new Date(data.subscriptionUntil).toLocaleDateString('ru-RU')}</div>
        <button className="btn gradient block">Поделиться подпиской</button>
        <Link to="/subscribe" className="row-link">
          <div>Сменить подписку</div>
          <span className="chevron">›</span>
        </Link>
        <div className="row-link">
          <div>Автопродление</div>
          <input type="checkbox" defaultChecked={data.autoRenewal} />
        </div>
        {hasCard ? (
          <div className="row-link">
            <div>Карта {data.cardMasked}</div>
            <button className="header-btn">🗑</button>
          </div>
        ) : (
          <div className="row-link">
            <div>Карта</div>
            <button className="btn secondary">Привязать карту</button>
          </div>
        )}
      </div>

      <div style={{ height: 12 }} />

      <div className="card" style={{ padding: 12 }}>
        <div className="muted">Мои рефералы</div>
        <button className="btn gradient block">Реферальная ссылка</button>
      </div>

      <div style={{ height: 12 }} />

      <div className="social">
        <div className="item"><span>Telegram</span><span className="chevron">›</span></div>
        <div className="item"><span>VK</span><span className="chevron">›</span></div>
        <div className="item"><span>Instagram</span><span className="chevron">›</span></div>
      </div>

      <div style={{ height: 12 }} />

      <div className="policy" style={{ display: 'grid', gap: 10 }}>
        <div className="item">Политика конфиденциальности</div>
        <div className="item">Правила пользования</div>
        <div className="item">Пользовательское соглашение</div>
      </div>

      <div style={{ height: 12 }} />

      <button className="btn secondary block">Оставить отзыв</button>
    </div>
  );
}

// --- Друзья ---
function Friends(): JSX.Element {
  const [items, setItems] = useState<Awaited<ReturnType<typeof fetchFriends>>>([]);
  const [until, setUntil] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ code: string; tgLink?: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [username, setUsername] = useState('');
  useEffect(() => { fetchFriends().then(setItems); }, []);
  useEffect(() => {
    fetchProfile().then((p) => {
      setUntil(p.subscriptionUntil);
      setAvatar(p.avatarUrl);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wa: any = (window as unknown as { Telegram?: unknown }).Telegram;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const u = wa?.WebApp?.initDataUnsafe?.user as { photo_url?: string } | undefined;
        if (u?.photo_url) setAvatar(u.photo_url);
      } catch {}
    }).catch(() => {});
  }, []);
  return (
    <div>
      <div className="card" style={{ padding: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {avatar ? (
            <img src={avatar} alt="a" width={36} height={36} style={{ borderRadius: 18 }} />
          ) : (
            <div className="card" style={{ width: 36, height: 36, borderRadius: 18 }} />
          )}
        </div>
        <div className="btn gradient" style={{ height: 32, padding: '0 12px' }}>Подписка до {until ? new Date(until).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '—'}</div>
      </div>
      <div style={{ height: 12 }} />
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {items.map((f) => (
          <div className="card" key={f.id} style={{ padding: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <img src={f.avatarUrl} alt="a" width={36} height={36} style={{ borderRadius: 18 }} />
            <div>{f.name}</div>
          </div>
        ))}
      </div>
      <div style={{ height: 12 }} />
      <div style={{ display: 'grid', gap: 10 }}>
        <button className="btn block" onClick={async () => {
          try {
            const r = await createFriendInvite();
            setInvite(r);
          } catch {
            alert('Не удалось создать приглашение. Попробуйте позже.');
          }
        }}>Пригласить друга</button>
        <button className="btn secondary block" onClick={() => setAddOpen(true)}>Добавить по нику</button>
      </div>

      {invite ? (
        <Sheet title="Приглашение" onClose={() => setInvite(null)}>
          <div className="muted">Отправьте другу ссылку или код.</div>
          <div style={{ height: 8 }} />
          <div style={{ display: 'grid', gap: 8 }}>
            {invite.tgLink ? (
              <>
                <input className="input" value={invite.tgLink} readOnly onFocus={(e) => e.currentTarget.select()} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn" onClick={async () => {
                    try { await navigator.clipboard.writeText(invite.tgLink || ''); alert('Ссылка скопирована'); } catch { /* ignore */ }
                  }}>Скопировать</button>
                  <button className="btn secondary" onClick={() => {
                    try {
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      const wa: any = (window as unknown as { Telegram?: unknown }).Telegram;
                      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                      const open = wa?.WebApp?.openTelegramLink as ((url: string) => void) | undefined;
                      if (open && invite.tgLink) open(invite.tgLink);
                      else if (invite.tgLink) window.open(invite.tgLink, '_blank');
                    } catch {}
                  }}>Открыть в Telegram</button>
                </div>
              </>
            ) : (
              <>
                <input className="input" value={invite.code} readOnly onFocus={(e) => e.currentTarget.select()} />
                <button className="btn" onClick={async () => { try { await navigator.clipboard.writeText(invite.code); alert('Код скопирован'); } catch {} }}>Скопировать код</button>
              </>
            )}
          </div>
        </Sheet>
      ) : null}

      {addOpen ? (
        <Sheet title="Добавить друга по нику" onClose={() => setAddOpen(false)}>
          <div style={{ display: 'grid', gap: 8 }}>
            <input className="input" placeholder="@username" value={username} onChange={(e) => setUsername(e.target.value)} />
            <button className="btn" onClick={async () => {
              const u = username.trim();
              if (!u) return;
              try {
                await addFriendByUsername(u);
                setAddOpen(false);
                setUsername('');
                const list = await fetchFriends();
                setItems(list);
              } catch {
                alert('Пользователь не найден или ошибка добавления');
              }
            }}>Добавить</button>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}

// --- Завершение игры ---
function GameFinished(): JSX.Element {
  const navigate = useNavigate();
  const [rating, setRating] = useState(3);
  const [comment, setComment] = useState('');
  return (
    <div>
      <h2>Игра завершена</h2>
      <div className="muted">Оцените качество игры...</div>
      <div style={{ display: 'flex', gap: 6, margin: '10px 0' }}>
        {[1, 2, 3, 4, 5].map((i) => (
          <button key={i} className={`btn ${rating >= i ? '' : 'secondary'}`} style={{ width: 40 }} onClick={() => setRating(i)}>★</button>
        ))}
      </div>
      <textarea className="input" placeholder="Комментарий" style={{ height: 96 }} value={comment} onChange={(e) => setComment(e.target.value)} />
      <div style={{ height: 10 }} />
      <button className="btn block" onClick={async () => { await sendFeedback({ rating, comment }); navigate('/catalog'); }}>Отправить и выйти</button>
    </div>
  );
}


