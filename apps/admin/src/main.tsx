import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Link, RouterProvider, useSearchParams } from 'react-router-dom';
import './styles.css';

type GameShort = {
  id: string;
  title: string;
  description: string;
  rating: number;
  tags: string[];
  author: string;
  coverUrl: string;
  status?: 'DRAFT' | 'TEST' | 'PUBLISHED';
};

function getApiBase(): string {
  if (typeof window === 'undefined') return 'http://localhost:4000/api';
  const host = window.location.hostname; // e.g. admin.miraplay.ru
  const parts = host.split('.');
  const root = parts.slice(-2).join('.'); // miraplay.ru
  if (root === 'localhost') return 'http://localhost:4000/api';
  return `${window.location.protocol}//api.${root}/api`;
}
const API = getApiBase();

function resolveAssetUrl(u?: string | null): string {
  const raw = String(u || '').trim();
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:')) return raw;
  if (raw.startsWith('/uploads/')) {
    try {
      const host = window.location.hostname; // admin.miraplay.ru
      const parts = host.split('.');
      const root = parts.slice(-2).join('.');
      const base = `${window.location.protocol}//api.${root}`;
      return `${base}${raw}`;
    } catch {
      return raw;
    }
  }
  return raw;
}

// --- New Game Wizard: manual vs D&D PDF import ---
const NewGameWizard: React.FC<{ onManualCreate: () => Promise<void> | void }> = ({ onManualCreate }) => {
  const [mode, setMode] = useState<'manual' | 'pdf'>('manual');
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [coverUrl, setCoverUrl] = useState('');
  const [rulesFile, setRulesFile] = useState<File | null>(null);
  const [scenarioFile, setScenarioFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<Array<{ fileName: string; status: 'pending' | 'processing' | 'done' | 'error'; progress?: string; error?: string; gameId?: string }>>([]);
  
  const handleRulesFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    if (file) {
      setRulesFile(file);
    }
    e.currentTarget.value = '';
  };
  
  const handleScenarioFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    if (file) {
      setScenarioFile(file);
    }
    e.currentTarget.value = '';
  };
  
  const onIngest = async () => {
    if (!rulesFile || !scenarioFile) {
      alert('Необходимо загрузить оба файла: правила и сценарий');
      return;
    }
    
    setUploadProgress([
      { fileName: rulesFile.name, status: 'pending' as const },
      { fileName: scenarioFile.name, status: 'pending' as const }
    ]);
    setBusy(true);
    
    try {
      // Отправляем два файла: правила и сценарий
      setUploadProgress(prev => prev.map(item => ({ ...item, status: 'processing' as const, progress: 'Отправка файлов...' })));
      
      const fd = new FormData();
      fd.append('rulesFile', rulesFile);
      fd.append('scenarioFile', scenarioFile);
      
      // Асинхронный импорт: стартуем задачу и опрашиваем статус
      const start = await fetch(`${API}/admin/ingest-import`, { method: 'POST', body: fd });
      const sj = await start.json().catch(() => ({} as any));
      if (!start.ok || !sj?.jobId) { 
        const errorMsg = sj?.error || sj?.details || sj?.message || 'Старт импорта не удался';
        console.error('[INGEST] Start failed:', sj);
        setUploadProgress(prev => prev.map(item => ({ ...item, status: 'error' as const, error: errorMsg })));
        alert(`Старт импорта не удался: ${errorMsg}`); 
        return;
      }
      
      const jobId = sj.jobId as string;
      let lastProgress = '';
      
      for (let i = 0; i < 600; i++) { // до ~20 минут (600 * 2с)
        await new Promise((r) => setTimeout(r, 2000));
        const st = await fetch(`${API}/admin/ingest-import/${encodeURIComponent(jobId)}`);
        const s = await st.json().catch(() => ({} as any));
        if (!st.ok) break;
        
        if (s?.progress && s.progress !== lastProgress) {
          lastProgress = s.progress;
          setUploadProgress(prev => prev.map(item => 
            item.status === 'processing' ? { ...item, progress: s.progress } : item
          ));
        }
        
        if (s?.status === 'error') { 
          setUploadProgress(prev => prev.map(item => ({ ...item, status: 'error' as const, error: s?.error || 'unknown' })));
          alert(`Импорт не удался: ${s?.error || 'unknown'}`); 
          return;
        }
        
        if (s?.status === 'done' && s?.gameId) {
          // применим пользовательские поля поверх
          if (title || author || coverUrl) {
            try {
              await fetch(`${API}/admin/games/${s.gameId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                title: title || undefined,
                author: author || undefined,
                coverUrl: coverUrl || undefined,
              }) });
            } catch {}
          }
          
          setUploadProgress(prev => prev.map(item => ({ ...item, status: 'done' as const, gameId: s.gameId })));
          
          // Переходим к созданной игре
          setTimeout(() => {
            window.location.href = `/admin/scenario?id=${s.gameId}`;
          }, 1000);
          return;
        }
      }
      
      alert('Импорт занял слишком много времени. Обновите страницу и проверьте список игр.');
    } catch (e) {
      setUploadProgress(prev => prev.map(item => ({ ...item, status: 'error' as const, error: String(e) })));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="radio" name="mode" checked={mode === 'manual'} onChange={() => { setMode('manual'); setRulesFile(null); setScenarioFile(null); setUploadProgress([]); }} /> Самому загрузить сюжет
        </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="radio" name="mode" checked={mode === 'pdf'} onChange={() => { setMode('pdf'); setRulesFile(null); setScenarioFile(null); setUploadProgress([]); }} /> Загрузить D&D из PDF/TXT (авто)
        </label>
      </div>
      {mode === 'manual' ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <input placeholder="Название" value={title} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)} />
          <input placeholder="Автор" value={author} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAuthor(e.target.value)} />
          <input placeholder="Обложка URL" value={coverUrl} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCoverUrl(e.target.value)} />
          <button onClick={async () => { await onManualCreate(); }}>Создать пустую игру</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          <div className="muted">При желании заполните поля ниже для перезаписи метаданных.</div>
          <input placeholder="Название (опц.)" value={title} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)} />
          <input placeholder="Автор (опц.)" value={author} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAuthor(e.target.value)} />
          <input placeholder="Обложка URL (опц.)" value={coverUrl} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCoverUrl(e.target.value)} />
          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <label style={{ display: 'block', marginBottom: 8, fontSize: '14px', fontWeight: 600, color: '#212529' }}>
                1. Файл правил (PDF или TXT)
              </label>
              <label style={{ display: 'block', cursor: busy ? 'not-allowed' : 'pointer' }}>
                <input type="file" accept=".pdf,.txt,application/pdf,text/plain" style={{ display: 'none' }} disabled={busy} onChange={handleRulesFileSelect} />
                <div
                  style={{ 
                    width: '100%', 
                    padding: '12px 20px', 
                    fontSize: '14px', 
                    fontWeight: 500,
                    backgroundColor: busy ? '#6c757d' : (rulesFile ? '#28a745' : '#1f6feb'),
                    color: '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: busy ? 'not-allowed' : 'pointer',
                    transition: 'all 0.2s ease',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span>📋</span>
                    <span>{rulesFile ? rulesFile.name : 'Выбрать файл правил'}</span>
                  </div>
                  {rulesFile && !busy && (
                    <span onClick={(e) => { e.stopPropagation(); setRulesFile(null); }} style={{ cursor: 'pointer', fontSize: '18px' }}>✕</span>
                  )}
                </div>
              </label>
            </div>
            
            <div>
              <label style={{ display: 'block', marginBottom: 8, fontSize: '14px', fontWeight: 600, color: '#212529' }}>
                2. Файл сценария (PDF или TXT)
              </label>
              <label style={{ display: 'block', cursor: busy ? 'not-allowed' : 'pointer' }}>
                <input type="file" accept=".pdf,.txt,application/pdf,text/plain" style={{ display: 'none' }} disabled={busy} onChange={handleScenarioFileSelect} />
                <div
                  style={{ 
                    width: '100%', 
                    padding: '12px 20px', 
                    fontSize: '14px', 
                    fontWeight: 500,
                    backgroundColor: busy ? '#6c757d' : (scenarioFile ? '#28a745' : '#1f6feb'),
                    color: '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: busy ? 'not-allowed' : 'pointer',
                    transition: 'all 0.2s ease',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span>📄</span>
                    <span>{scenarioFile ? scenarioFile.name : 'Выбрать файл сценария'}</span>
                  </div>
                  {scenarioFile && !busy && (
                    <span onClick={(e) => { e.stopPropagation(); setScenarioFile(null); }} style={{ cursor: 'pointer', fontSize: '18px' }}>✕</span>
                  )}
                </div>
              </label>
            </div>
            
            {!busy && rulesFile && scenarioFile && (
              <button
                onClick={onIngest}
                style={{
                  width: '100%',
                  padding: '14px 24px',
                  fontSize: '16px',
                  fontWeight: 600,
                  backgroundColor: '#28a745',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '10px',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  boxShadow: '0 2px 8px rgba(40, 167, 69, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px'
                }}
                onMouseEnter={(e) => { 
                  e.currentTarget.style.backgroundColor = '#218838';
                  e.currentTarget.style.boxShadow = '0 4px 12px rgba(40, 167, 69, 0.4)';
                  e.currentTarget.style.transform = 'translateY(-1px)';
                }}
                onMouseLeave={(e) => { 
                  e.currentTarget.style.backgroundColor = '#28a745';
                  e.currentTarget.style.boxShadow = '0 2px 8px rgba(40, 167, 69, 0.3)';
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                <span>🚀</span>
                <span>Загрузить и создать игру</span>
              </button>
            )}
          </div>
          
          {uploadProgress.length > 0 && (
            <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
              {uploadProgress.map((item, idx) => (
                <div key={idx} style={{ 
                  padding: 10, 
                  borderRadius: 6, 
                  backgroundColor: item.status === 'done' ? '#d4edda' : item.status === 'error' ? '#f8d7da' : item.status === 'processing' ? '#d1ecf1' : '#e9ecef',
                  border: `1px solid ${item.status === 'done' ? '#c3e6cb' : item.status === 'error' ? '#f5c6cb' : item.status === 'processing' ? '#bee5eb' : '#dee2e6'}`,
                  fontSize: '14px'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: item.progress ? 4 : 0 }}>
                    <span>{item.status === 'done' ? '✅' : item.status === 'error' ? '❌' : item.status === 'processing' ? '⏳' : '⏸️'}</span>
                    <span style={{ fontWeight: 500 }}>{item.fileName}</span>
                    <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#6c757d' }}>
                      {item.status === 'done' ? 'Готово' : item.status === 'error' ? 'Ошибка' : item.status === 'processing' ? 'Обработка...' : 'Ожидание'}
                    </span>
                  </div>
                  {item.progress && item.status === 'processing' && (
                    <div style={{ fontSize: '12px', color: '#495057', marginTop: 4 }}>{item.progress}</div>
                  )}
                  {item.error && (
                    <div style={{ fontSize: '12px', color: '#721c24', marginTop: 4 }}>Ошибка: {item.error}</div>
                  )}
                  {item.status === 'done' && item.gameId && (
                    <div style={{ marginTop: 8 }}>
                      <a 
                        href={`/admin/scenario?id=${item.gameId}`}
                        style={{ 
                          fontSize: '12px', 
                          color: '#1f6feb', 
                          textDecoration: 'none',
                          fontWeight: 500
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
                      >
                        → Открыть игру
                      </a>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const DashboardPage: React.FC = () => {
  const [overview, setOverview] = useState<{ totalUsers: number; premium: number; trial: number; free: number; totalGames: number; topGame: string | null } | null>(null);
  const [top, setTop] = useState<{ id: string; title: string; rating: number }[]>([]);
  useEffect(() => {
    fetch(`${API}/analytics/overview`).then(async (r) => setOverview(await r.json()));
    fetch(`${API}/analytics/games-top`).then(async (r) => setTop(await r.json()));
  }, []);
  return (
    <div style={{ padding: 16, display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', gap: 12 }}>
        <Link to="/admin">Дашборд</Link>
        <Link to="/admin/games">Игры</Link>
        <Link to="/admin/users">Пользователи</Link>
        <Link to="/admin/characters">Персонажи</Link>
        <Link to="/admin/feedback">Отзывы</Link>
      </div>
      <h2>Дашборд</h2>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(5, 1fr)' }}>
        <div className="card" style={{ padding: 12 }}><div className="muted">Пользователей</div><div style={{ fontSize: 24, fontWeight: 700 }}>{overview?.totalUsers ?? '—'}</div></div>
        <div className="card" style={{ padding: 12 }}><div className="muted">Premium</div><div style={{ fontSize: 24, fontWeight: 700 }}>{overview?.premium ?? '—'}</div></div>
        <div className="card" style={{ padding: 12 }}><div className="muted">Trial</div><div style={{ fontSize: 24, fontWeight: 700 }}>{overview?.trial ?? '—'}</div></div>
        <div className="card" style={{ padding: 12 }}><div className="muted">Free</div><div style={{ fontSize: 24, fontWeight: 700 }}>{overview?.free ?? '—'}</div></div>
        <div className="card" style={{ padding: 12 }}><div className="muted">Игр</div><div style={{ fontSize: 24, fontWeight: 700 }}>{overview?.totalGames ?? '—'}</div></div>
      </div>
      <div className="card" style={{ padding: 12 }}>
        <h3>Топ игр</h3>
        <ol>
          {top.map((t) => (<li key={t.id}>{t.title} — {t.rating.toFixed(1)}</li>))}
        </ol>
      </div>
    </div>
  );
};

const GamesPage: React.FC = () => {
  const [list, setList] = useState<GameShort[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<Partial<GameShort>>({ title: '', description: '', rating: 5, tags: [], author: '', coverUrl: '' });

  const load = async () => {
    setLoading(true);
    const res = await fetch(`${API}/admin/games`);
    setList(await res.json());
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const onCreate = async () => {
    const payload = {
      title: form.title || 'Новая игра',
      description: form.description || '',
      rating: Number(form.rating) || 5,
      tags: form.tags || [],
      author: form.author || 'Автор',
      coverUrl: form.coverUrl || 'https://picsum.photos/seed/new/800/360',
      gallery: [],
      rules: 'Правила...',
      editions: [{ id: 'e1', name: 'Стандарт', description: '—', price: 990 }],
    };
    await fetch(`${API}/games`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    await load();
  };

  const onDelete = async (id: string) => {
    await fetch(`${API}/games/${id}`, { method: 'DELETE' });
    await load();
  };

  return (
    <div style={{ padding: 16, display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', gap: 12 }}>
        <Link to="/admin">Дашборд</Link>
        <Link to="/admin/games">Игры</Link>
        <Link to="/admin/scenario">Сценарий</Link>
        <Link to="/admin/users">Пользователи</Link>
        <Link to="/admin/characters">Персонажи</Link>
        <Link to="/admin/feedback">Отзывы</Link>
      </div>
      <h2>Игры</h2>
      <div className="card" style={{ padding: 12 }}>
        <h3>Добавить игру</h3>
        <NewGameWizard onManualCreate={onCreate} />
      </div>
      <div className="card" style={{ padding: 12 }}>
        <h3>Список игр</h3>
        {loading ? 'Загрузка...' : (
          <ul>
            {list.map((g) => (
              <li key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <img src={g.coverUrl} alt="c" width={60} height={36} />
                <span>{g.title}</span>
                {g.status && <span className="muted">[{g.status}]</span>}
                <Link to={`/admin/scenario?id=${g.id}`} style={{ marginLeft: 'auto' }}>Редактор</Link>
                <button onClick={() => onDelete(g.id)}>Удалить</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

// --- AI Settings (inner component) ---
const AiSettingsInner: React.FC = () => {
  const [system, setSystem] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API}/admin/ai-prompts`);
        const j = await r.json().catch(() => ({} as any));
        setSystem(String(j?.system || '').trim());
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  if (loading) return <div>Загрузка…</div>;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div className="muted">Этот текст используется как системный промт для ИИ. Изменения применяются после сохранения.</div>
      <textarea value={system} onChange={(e) => setSystem(e.target.value)} rows={10} style={{ width: '100%' }} />
      <div>
        <button disabled={saving} onClick={async () => {
          setSaving(true);
          try {
            const r = await fetch(`${API}/admin/ai-prompts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system }) });
            if (!r.ok) {
              const j = await r.json().catch(() => ({} as any));
              alert(`Не удалось сохранить: ${j?.error || r.status}`);
              return;
            }
            alert('Системный промт сохранён');
          } finally {
            setSaving(false);
          }
        }}>Сохранить</button>
      </div>
    </div>
  );
};

const ScenarioPage: React.FC = () => {
  const [params] = useSearchParams();
  const id = params.get('id');
  const [game, setGame] = useState<any | null>(null);
  const [saving, setSaving] = useState(false);
  const [newLoc, setNewLoc] = useState<{ title: string; backgroundUrl: string; musicUrl: string }>({ title: '', backgroundUrl: '', musicUrl: '' });
  const [exitsMap, setExitsMap] = useState<Record<string, any[]>>({});
  const [flowExits, setFlowExits] = useState<any[]>([]);
  const [newExit, setNewExit] = useState<Record<string, { type: 'BUTTON' | 'TRIGGER' | 'GAMEOVER'; buttonText?: string; triggerText?: string; targetLocationId?: string; isGameOver?: boolean }>>({});
  const uploadAsset = async (file: File, kind?: 'image' | 'audio'): Promise<string> => {
    const fd = new FormData();
    fd.append('file', file);
    if (kind) fd.append('kind', kind);
    const r = await fetch(`${API}/admin/upload`, { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({} as any));
    if (!r.ok || !j?.url) throw new Error('upload_failed');
    return j.url as string;
  };
  const handleExport = async () => {
    if (!game) return;
    const locs = (game.locations || []) as Array<any>;
    const exits: any[] = [];
    for (const loc of locs) {
      const list = exitsMap[loc.id] || [];
      for (const ex of list) {
        exits.push({
          fromKey: loc.id,
          type: ex.type,
          buttonText: ex.buttonText || null,
          triggerText: ex.triggerText || null,
          toKey: ex.targetLocationId || null,
          isGameOver: Boolean(ex.isGameOver),
        });
      }
    }
    const payload = {
      game: {
        title: game.title,
        description: game.description,
        author: game.author,
        coverUrl: game.coverUrl,
        tags: game.tags,
        rules: game.rules,
        worldRules: game.worldRules,
        gameplayRules: game.gameplayRules,
        introduction: game.introduction,
        backstory: game.backstory,
        adventureHooks: game.adventureHooks,
        status: game.status,
      },
      locations: locs.map((l: any, i: number) => ({
        key: l.id,
        order: l.order ?? (i + 1),
        title: l.title,
        description: l.description,
        rulesPrompt: l.rulesPrompt,
        backgroundUrl: l.backgroundUrl,
        musicUrl: l.musicUrl,
      })),
      exits,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(game.title || 'scenario').replace(/\s+/g, '_')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };
  const handleImport = async (file: File) => {
    const txt = await file.text();
    const json = JSON.parse(txt);
    const r = await fetch(`${API}/admin/scenario/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) });
    const j = await r.json().catch(() => ({} as any));
    if (!r.ok || !j?.gameId) { alert('Импорт не удался'); return; }
    window.location.href = `/admin/scenario?id=${j.gameId}`;
  };
  const moveLocation = async (locId: string, dir: 'up' | 'down') => {
    if (!game?.locations?.length) return;
    const list = [...game.locations] as Array<any>;
    const idx = list.findIndex((l) => l.id === locId);
    if (idx < 0) return;
    const swapWith = dir === 'up' ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= list.length) return;
    const a = list[idx], b = list[swapWith];
    await fetch(`${API}/locations/${a.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: b.order ?? (swapWith + 1) }) });
    await fetch(`${API}/locations/${b.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: a.order ?? (idx + 1) }) });
    await load();
    const el = document.getElementById(`loc-${a.id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const load = async () => {
    if (!id) return;
    const res = await fetch(`${API}/admin/games/${id}/full`);
    if (res.ok) {
      const data = await res.json();
      setGame(data);
      try {
        const map: Record<string, any[]> = {};
        const locs = Array.isArray(data.locations) ? data.locations : [];
        // 1) Пытаемся получить сводный список выходов по игре
        let filled = false;
        try {
          const rAll = await fetch(`${API}/games/${data.id}/exits`);
          const all = await rAll.json().catch(() => ([] as any[]));
          if (rAll.ok && Array.isArray(all) && all.length) {
            setFlowExits(all);
            for (const l of locs) map[l.id] = [];
            for (const ex of all) {
              const k = ex.locationId as string;
              if (!map[k]) map[k] = [];
              map[k].push(ex);
            }
            filled = true;
          }
        } catch {}
        // 2) Если не удалось — пробуем из /full (locations[].exits)
        if (!filled) {
          const agg: any[] = [];
          for (const l of locs) {
            const list = Array.isArray(l.exits) ? l.exits : [];
            if (list.length) filled = true;
            if (list.length) agg.push(...list);
            map[l.id] = list.slice();
          }
          if (filled) setFlowExits(agg);
        }
        // 3) Если всё ещё пусто — дотянем поштучно
        if (!filled) {
          const entries: Array<[string, any[]]> = await Promise.all(locs.map(async (l: any) => {
            try {
              const r = await fetch(`${API}/locations/${l.id}/exits`);
              const j = await r.json().catch(() => ([] as any[]));
              if (!r.ok || !Array.isArray(j)) return [l.id, [] as any[]];
              return [l.id, j as any[]];
            } catch {
              return [l.id, [] as any[]];
            }
          }));
          const agg: any[] = [];
          for (const [k, v] of entries) map[k] = v;
          for (const [, v] of entries) agg.push(...v);
          setFlowExits(agg);
        }
        setExitsMap(map);
      } catch {
        setExitsMap({});
        setFlowExits([]);
      }
    }
  };
  useEffect(() => { load(); }, [id]);

  const save = async () => {
    if (!id || !game) return;
    setSaving(true);
    await fetch(`${API}/admin/games/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      title: game.title,
      description: game.description,
      tags: game.tags,
      author: game.author,
      coverUrl: game.coverUrl,
      rules: game.rules,
      gallery: game.gallery,
      worldRules: game.worldRules,
      gameplayRules: game.gameplayRules,
      introduction: game.introduction,
      backstory: game.backstory,
      adventureHooks: game.adventureHooks,
      vkVideoUrl: game.vkVideoUrl,
      promoDescription: game.promoDescription,
      marketplaceLinks: game.marketplaceLinks,
      shelfCategory: game.shelfCategory,
      shelfPosition: Number(game.shelfPosition) || null,
      bannerStyle: game.bannerStyle,
      ageRating: game.ageRating,
      authorUserId: game.authorUserId,
      status: game.status,
      winCondition: game.winCondition,
      loseCondition: game.loseCondition,
      deathCondition: game.deathCondition,
      finalScreenUrl: game.finalScreenUrl,
    }) });
    setSaving(false);
    load();
  };

  const addLocation = async () => {
    if (!id) return;
    await fetch(`${API}/games/${id}/locations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newLoc) });
    setNewLoc({ title: '', backgroundUrl: '', musicUrl: '' });
    load();
  };

  const updateLocation = async (locId: string, patch: any) => {
    await fetch(`${API}/locations/${locId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    load();
  };
  const deleteLocation = async (locId: string) => {
    await fetch(`${API}/locations/${locId}`, { method: 'DELETE' });
    load();
  };

  const addExit = async (locId: string) => {
    const payload = newExit[locId] || { type: 'BUTTON' as const };
    const r = await fetch(`${API}/locations/${locId}/exits`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      type: payload.type,
      buttonText: payload.buttonText,
      triggerText: payload.triggerText,
      targetLocationId: payload.targetLocationId || null,
      isGameOver: Boolean(payload.isGameOver),
    }) });
    if (r.ok) {
      const created = await r.json().catch(() => null as any);
      // Локально обновим список у локации (чтобы Flow сразу увидел)
      setGame((g: any) => {
        if (!g) return g;
        const next = { ...g, locations: (g.locations || []).map((l: any) => {
          if (l.id !== locId) return l;
          const list = Array.isArray(l.exits) ? l.exits.slice() : [];
          if (created) list.push(created);
          return { ...l, exits: list };
        }) };
        return next;
      });
      if (created) setFlowExits((prev) => prev.concat([created]));
      setExitsMap((prev) => {
        const list = Array.isArray(prev[locId]) ? prev[locId].slice() : [];
        if (created) list.push(created);
        return { ...prev, [locId]: list };
      });
      setNewExit((m) => ({ ...m, [locId]: { type: 'BUTTON' } as any }));
      await load(); // синхронизируем список и Flow
    } else {
      alert('Не удалось добавить выход');
    }
  };
  const updateExit = async (exitId: string, patch: any) => {
    const r = await fetch(`${API}/exits/${exitId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    if (!r.ok) alert('Не удалось сохранить выход');
    await load();
  };
  const deleteExit = async (exitId: string) => {
    const r = await fetch(`${API}/exits/${exitId}`, { method: 'DELETE' });
    if (!r.ok) alert('Не удалось удалить выход');
    await load();
  };

  if (!id) return <div style={{ padding: 16 }}>Не указан id игры. Откройте через список игр.</div>;
  if (!game) return <div style={{ padding: 16 }}>Загрузка...</div>;

  return (
    <div style={{ padding: 16, display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', gap: 12 }}>
        <Link to="/admin">Дашборд</Link>
        <Link to="/admin/games">Игры</Link>
        <Link to="/admin/scenario">Сценарий</Link>
        <Link to="/admin/users">Пользователи</Link>
        <a href="#ai-settings">Настройка ИИ</a>
      </div>
      {game && (
        <div className="card" style={{ padding: 12, display: 'grid', gap: 10 }}>
          <h2 style={{ margin: 0 }}>Редактор сценария — {game.title}</h2>
          <div className="muted">ID: {game.id}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={save} disabled={saving}>{saving ? 'Сохранение...' : 'Сохранить метаданные'}</button>
            <button
              className={game.status === 'PUBLISHED' ? 'btn secondary' : 'btn'}
              onClick={async () => {
                try {
                  const next = game.status === 'PUBLISHED' ? 'DRAFT' : 'PUBLISHED';
                  await fetch(`${API}/admin/games/${game.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }) });
                  setGame({ ...game, status: next });
                } catch {
                  alert('Не удалось изменить статус');
                }
              }}
              title={game.status === 'PUBLISHED' ? 'Снять с публикации' : 'Опубликовать'}
            >
              {game.status === 'PUBLISHED' ? 'Снять с публикации' : 'Опубликовать'}
            </button>
            <button onClick={handleExport}>Экспорт JSON</button>
            <label className="btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span>Импорт JSON</span>
              <input type="file" accept="application/json" style={{ display: 'none' }} onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value=''; if (f) void handleImport(f); }} />
            </label>
            <a href="/admin/games"><button>Назад к играм</button></a>
          </div>
        </div>
      )}
      <div className="card" style={{ padding: 12 }}>
        <h3>Локации — фон и музыка (загрузка файлов)</h3>
        <div className="muted">Прикрепляйте картинку фона и аудиодорожку — URL выставятся автоматически.</div>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          {(game.locations || []).map((loc: any) => (
            <li key={loc.id} id={`loc-${loc.id}`} className="card" style={{ padding: 10 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ minWidth: 220 }}>
                  <div style={{ fontWeight: 600 }}>{loc.title}</div>
                  <div className="muted" style={{ fontSize: 12 }}>id: {loc.id}</div>
                </div>
                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ width: 80 }}>Фон:</span>
                    {loc.backgroundUrl ? <img src={resolveAssetUrl(loc.backgroundUrl)} alt="bg" width={120} height={68} style={{ objectFit: 'cover', borderRadius: 6 }} /> : <span className="muted">—</span>}
                    <button
                      className="header-btn"
                      onClick={async () => {
                        try {
                          const r = await fetch(`${API}/admin/locations/${loc.id}/generate-background?provider=gemini`, { method: 'POST' });
                          const j = await r.json().catch(() => ({} as any));
                          if (!r.ok || !j?.ok) { alert('Не удалось сгенерировать фон'); return; }
                          load();
                        } catch {
                          alert('Не удалось сгенерировать фон');
                        }
                      }}
                    >
                      Сгенерировать фон
                    </button>
                    <input type="file" accept="image/*" onChange={async (e) => {
                      const f = e.currentTarget.files?.[0]; e.currentTarget.value = '';
                      if (!f) return;
                      try {
                        const url = await uploadAsset(f, 'image');
                        await fetch(`${API}/locations/${loc.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backgroundUrl: url }) });
                        load();
                      } catch { alert('Не удалось загрузить фон'); }
                    }} />
                    <input
                      style={{ width: 360 }}
                      placeholder="или URL"
                      defaultValue={loc.backgroundUrl || ''}
                      onBlur={(e) => fetch(`${API}/locations/${loc.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backgroundUrl: e.currentTarget.value || null }) }).then(load)}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ width: 80 }}>Музыка:</span>
                    {loc.musicUrl ? <audio src={loc.musicUrl} controls style={{ height: 28 }} /> : <span className="muted">—</span>}
                    <input type="file" accept="audio/*" onChange={async (e) => {
                      const f = e.currentTarget.files?.[0]; e.currentTarget.value = '';
                      if (!f) return;
                      try {
                        const url = await uploadAsset(f, 'audio');
                        await fetch(`${API}/locations/${loc.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ musicUrl: url }) });
                        load();
                      } catch { alert('Не удалось загрузить аудио'); }
                    }} />
                    <input
                      style={{ width: 360 }}
                      placeholder="или URL"
                      defaultValue={loc.musicUrl || ''}
                      onBlur={(e) => fetch(`${API}/locations/${loc.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ musicUrl: e.currentTarget.value || null }) }).then(load)}
                    />
                  </div>
                  <div style={{ display: 'grid', gap: 6 }}>
                    <div className="muted">Правила Локации (мини‑промпт для интерпретации действий). Скопируйте из PDF.</div>
                    <textarea
                      placeholder={`Примеры:\n- Проверка Мудрости (Восприятие) Сл 10 (осмотр урн)\n- Найти 2 изумруда (инвентарь)\n- Вставить изумруды в статую (переход)`}
                      defaultValue={loc.rulesPrompt || ''}
                      onBlur={(e) => fetch(`${API}/locations/${loc.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rulesPrompt: e.currentTarget.value || null }) }).then(load)}
                    />
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <a id="ai-settings" />
      <div className="card" style={{ padding: 12, display: 'grid', gap: 10 }}>
        <h3>Настройка ИИ — системный промт</h3>
        <AiSettingsInner />
      </div>
      <h2>Редактор сценария — {game.title}</h2>
      <div className="card" style={{ padding: 12, display: 'grid', gap: 8, gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <input placeholder="Название" value={game.title} onChange={(e) => setGame({ ...game, title: e.target.value })} />
        <input placeholder="Автор (текст)" value={game.author} onChange={(e) => setGame({ ...game, author: e.target.value })} />
        <input placeholder="Автор (userId)" value={game.authorUserId || ''} onChange={(e) => setGame({ ...game, authorUserId: e.target.value })} />
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input placeholder="Обложка URL" value={game.coverUrl} onChange={(e) => setGame({ ...game, coverUrl: e.target.value })} />
            {game.coverUrl ? <img src={resolveAssetUrl(game.coverUrl)} alt="cover" width={120} height={68} style={{ objectFit: 'cover', borderRadius: 6 }} /> : null}
            <label className="btn">
              Загрузить
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={async (e) => {
                const f = e.currentTarget.files?.[0]; e.currentTarget.value='';
                if (!f) return;
                try {
                  const fd = new FormData(); fd.append('file', f); fd.append('kind', 'image');
                  const r = await fetch(`${API}/admin/upload`, { method: 'POST', body: fd });
                  const j = await r.json().catch(() => ({} as any));
                  if (r.ok && j.url) setGame((g: any) => ({ ...g, coverUrl: j.url }));
                } catch {}
              }} />
            </label>
          </div>
          {game.coverUrl ? <img src={game.coverUrl} alt="cover" style={{ maxWidth: '100%', height: 120, objectFit: 'cover', borderRadius: 6 }} /> : <div className="muted">Предпросмотр обложки</div>}
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input placeholder="VK видео URL" value={game.vkVideoUrl || ''} onChange={(e) => setGame({ ...game, vkVideoUrl: e.target.value })} />
            <label className="btn">
              Загрузить видео
              <input type="file" accept="video/*" style={{ display: 'none' }} onChange={async (e) => {
                const f = e.currentTarget.files?.[0]; e.currentTarget.value='';
                if (!f) return;
                try {
                  const fd = new FormData(); fd.append('file', f); fd.append('kind', 'video');
                  const r = await fetch(`${API}/admin/upload`, { method: 'POST', body: fd });
                  const j = await r.json().catch(() => ({} as any));
                  if (r.ok && j.url) setGame((g: any) => ({ ...g, vkVideoUrl: j.url }));
                } catch {}
              }} />
            </label>
          </div>
          {game.vkVideoUrl ? (
            <div className="card" style={{ padding: 6 }}>
              <iframe src={game.vkVideoUrl} title="vk-video" style={{ width: '100%', height: 220, border: 0 }} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />
            </div>
          ) : <div className="muted">Предпросмотр VK видео появится здесь</div>}
        </div>
        <select value={game.status || 'DRAFT'} onChange={(e) => setGame({ ...game, status: e.target.value })}>
          <option value="DRAFT">Черновик</option>
          <option value="TEST">Тест (видно админу)</option>
          <option value="PUBLISHED">Релиз (видно всем)</option>
        </select>
        <select value={game.ageRating || ''} onChange={(e) => setGame({ ...game, ageRating: e.target.value || null })}>
          <option value="">Возрастной рейтинг</option>
          <option value="G0">0+</option>
          <option value="G6">6+</option>
          <option value="G12">12+</option>
          <option value="G16">16+</option>
          <option value="G18">18+</option>
        </select>
        <select value={game.shelfCategory || ''} onChange={(e) => setGame({ ...game, shelfCategory: e.target.value || null })}>
          <option value="">Категория на полке</option>
          <option value="MAIN">MAIN</option>
          <option value="NEW">NEW</option>
          <option value="POPULAR">POPULAR</option>
          <option value="FANTASY">FANTASY</option>
          <option value="TEAM">TEAM</option>
          <option value="PUZZLE">PUZZLE</option>
        </select>
        <input type="number" placeholder="Позиция на полке" value={game.shelfPosition || ''} onChange={(e) => setGame({ ...game, shelfPosition: Number(e.target.value) })} />
        <select value={game.bannerStyle || ''} onChange={(e) => setGame({ ...game, bannerStyle: e.target.value || null })}>
          <option value="">Стиль баннера</option>
          <option value="DEFAULT">DEFAULT</option>
          <option value="WIDE">WIDE</option>
          <option value="TALL">TALL</option>
          <option value="VIDEO">VIDEO</option>
        </select>
      </div>
      <div className="card" style={{ padding: 12 }}>
        <h3>Издания (комплекты)</h3>
        <EditionsEditor gameId={game.id} />
      </div>
      <div className="card" style={{ padding: 12 }}>
        <h3>Описание и промо</h3>
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '1fr 1fr' }}>
          <textarea placeholder="Описание" value={game.description || ''} onChange={(e) => setGame({ ...game, description: e.target.value })} />
          <textarea placeholder="Промо описание" value={game.promoDescription || ''} onChange={(e) => setGame({ ...game, promoDescription: e.target.value })} />
          <input placeholder="Теги через запятую" value={(game.tags || []).join(',')} onChange={(e) => setGame({ ...game, tags: e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean) })} />
          <input placeholder="Ссылки маркетплейсов (через запятую)" value={(game.marketplaceLinks || []).join(',')} onChange={(e) => setGame({ ...game, marketplaceLinks: e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean) })} />
        </div>
      </div>
      <div className="card" style={{ padding: 12 }}>
        <h3>Введение / Предыстория / Зацепки приключения</h3>
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '1fr 1fr' }}>
          <textarea placeholder="Введение" value={game.introduction || ''} onChange={(e) => setGame({ ...game, introduction: e.target.value })} />
          <textarea placeholder="Предыстория" value={game.backstory || ''} onChange={(e) => setGame({ ...game, backstory: e.target.value })} />
          <textarea placeholder="Зацепки приключения" value={game.adventureHooks || ''} onChange={(e) => setGame({ ...game, adventureHooks: e.target.value })} />
        </div>
      </div>
      <div className="card" style={{ padding: 12 }}>
        <h3>Правила</h3>
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '1fr 1fr' }}>
          <textarea placeholder="Правила мира" value={game.worldRules || ''} onChange={(e) => setGame({ ...game, worldRules: e.target.value })} />
          <textarea placeholder="Правила игрового процесса" value={game.gameplayRules || ''} onChange={(e) => setGame({ ...game, gameplayRules: e.target.value })} />
          <textarea placeholder="Условие победы" value={game.winCondition || ''} onChange={(e) => setGame({ ...game, winCondition: e.target.value })} />
          <textarea placeholder="Условие поражения" value={game.loseCondition || ''} onChange={(e) => setGame({ ...game, loseCondition: e.target.value })} />
          <textarea placeholder="Условие смерти" value={game.deathCondition || ''} onChange={(e) => setGame({ ...game, deathCondition: e.target.value })} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input placeholder="Финальная заставка URL" value={game.finalScreenUrl || ''} onChange={(e) => setGame({ ...game, finalScreenUrl: e.target.value })} />
            <label className="btn">
              Загрузить
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={async (e) => {
                const f = e.currentTarget.files?.[0]; e.currentTarget.value='';
                if (!f) return;
                try {
                  const fd = new FormData(); fd.append('file', f); fd.append('kind', 'image');
                  const r = await fetch(`${API}/admin/upload`, { method: 'POST', body: fd });
                  const j = await r.json().catch(() => ({} as any));
                  if (r.ok && j.url) setGame((g: any) => ({ ...g, finalScreenUrl: j.url }));
                } catch {}
              }} />
            </label>
          </div>
        </div>
      </div>
      <div className="card" style={{ padding: 12 }}>
        <h3>Локации</h3>
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <input placeholder="Название" value={newLoc.title} onChange={(e) => setNewLoc({ ...newLoc, title: e.target.value })} />
          <input placeholder="Фон URL" value={newLoc.backgroundUrl} onChange={(e) => setNewLoc({ ...newLoc, backgroundUrl: e.target.value })} />
          <input placeholder="Музыка URL" value={newLoc.musicUrl} onChange={(e) => setNewLoc({ ...newLoc, musicUrl: e.target.value })} />
          <button onClick={addLocation}>Добавить локацию</button>
        </div>
        <ul>
          {(game.locations || []).map((loc: any) => (
            <li key={loc.id} style={{ display: 'grid', gap: 8, gridTemplateColumns: '60px 1fr 1fr 1fr auto', alignItems: 'center', marginTop: 8 }}>
              <div className="muted" title="Порядок">{loc.order ?? '-'}</div>
              <input value={loc.title} onChange={(e) => updateLocation(loc.id, { title: e.target.value })} />
              <input value={loc.backgroundUrl || ''} onChange={(e) => updateLocation(loc.id, { backgroundUrl: e.target.value })} />
              <input value={loc.musicUrl || ''} onChange={(e) => updateLocation(loc.id, { musicUrl: e.target.value })} />
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button className="header-btn" title="Вверх" onClick={() => moveLocation(loc.id, 'up')}>↑</button>
                <button className="header-btn" title="Вниз" onClick={() => moveLocation(loc.id, 'down')}>↓</button>
                <button onClick={() => deleteLocation(loc.id)} className="header-btn danger">Удалить</button>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="card" style={{ padding: 12 }}>
        <h3>Выходы / триггеры по локациям</h3>
        <div className="muted">Для каждой сцены задайте кнопки (BUTTON), правила по ключевой фразе (TRIGGER) или финал (GAMEOVER). Укажите целевую сцену для перехода.</div>
        <div style={{ height: 8 }} />
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          {(game.locations || []).map((loc: any) => (
            <li key={loc.id} className="card" style={{ padding: 10 }}>
              <div style={{ fontWeight: 600 }}>{loc.title}</div>
              <div className="muted">id: {loc.id}</div>
              <div style={{ height: 6 }} />
              <div style={{ display: 'grid', gap: 6 }}>
                {(exitsMap[loc.id] || []).map((ex: any) => (
                  <div key={ex.id} className="row-link" style={{ alignItems: 'center', gap: 8 }}>
                    <span className="muted">[{ex.type}]</span>
                    <input style={{ width: 160 }} placeholder="Кнопка" defaultValue={ex.buttonText || ''} onBlur={(e) => updateExit(ex.id, { buttonText: e.target.value })} />
                    <input style={{ width: 220 }} placeholder="Триггер (фраза)" defaultValue={ex.triggerText || ''} onBlur={(e) => updateExit(ex.id, { triggerText: e.target.value })} />
                    <select defaultValue={ex.targetLocationId || ''} onChange={(e) => updateExit(ex.id, { targetLocationId: e.target.value || null })}>
                      <option value="">— целевая сцена —</option>
                      {(game.locations || []).map((l2: any) => <option key={l2.id} value={l2.id}>{l2.title}</option>)}
                    </select>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input type="checkbox" defaultChecked={Boolean(ex.isGameOver)} onChange={(e) => updateExit(ex.id, { isGameOver: e.target.checked })} /> Game Over
                    </label>
                    <button onClick={() => deleteExit(ex.id)} className="header-btn danger">Удалить</button>
                  </div>
                ))}
              </div>
              <div style={{ height: 8 }} />
              <div className="card" style={{ padding: 8, display: 'grid', gap: 6 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select value={(newExit[loc.id]?.type || 'BUTTON') as any} onChange={(e) => setNewExit((m) => ({ ...m, [loc.id]: { ...(m[loc.id] || {}), type: e.target.value as any } }))}>
                    <option value="BUTTON">BUTTON</option>
                    <option value="TRIGGER">TRIGGER</option>
                    <option value="GAMEOVER">GAMEOVER</option>
                  </select>
                  <input style={{ width: 160 }} placeholder="Кнопка" value={newExit[loc.id]?.buttonText || ''} onChange={(e) => setNewExit((m) => ({ ...m, [loc.id]: { ...(m[loc.id] || { type: 'BUTTON' }), buttonText: e.target.value } }))} />
                  <input style={{ width: 220 }} placeholder="Триггер (фраза)" value={newExit[loc.id]?.triggerText || ''} onChange={(e) => setNewExit((m) => ({ ...m, [loc.id]: { ...(m[loc.id] || { type: 'BUTTON' }), triggerText: e.target.value } }))} />
                  <select value={newExit[loc.id]?.targetLocationId || ''} onChange={(e) => setNewExit((m) => ({ ...m, [loc.id]: { ...(m[loc.id] || { type: 'BUTTON' }), targetLocationId: e.target.value || '' } }))}>
                    <option value="">— целевая сцена —</option>
                    {(game.locations || []).map((l2: any) => <option key={l2.id} value={l2.id}>{l2.title}</option>)}
                  </select>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={Boolean(newExit[loc.id]?.isGameOver)} onChange={(e) => setNewExit((m) => ({ ...m, [loc.id]: { ...(m[loc.id] || { type: 'BUTTON' }), isGameOver: e.target.checked } }))} /> Game Over
                  </label>
                  <button onClick={() => addExit(loc.id)}>Добавить выход</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="card" style={{ padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Обзор переходов (Flow)</h3>
          <button
            className="header-btn"
            onClick={async () => {
              try {
                if (!game?.id) return;
                const r = await fetch(`${API}/games/${game.id}/exits`, { headers: { 'Cache-Control': 'no-store' } });
                const all = await r.json().catch(() => ([] as any[]));
                if (Array.isArray(all)) setFlowExits(all);
              } catch {}
            }}
            title="Принудительно обновить список переходов"
          >
            Обновить Flow
          </button>
        </div>
        <div className="muted">Сводка связей сцен. Помогает заметить сцены без выходов или целевой локации.</div>
        <div style={{ height: 8 }} />
        <div style={{ display: 'grid', gap: 8 }}>
          {(game.locations || []).map((loc: any) => {
            // Подготовим справочник выходов по локациям
            const grouped: Record<string, any[]> = {};
            if (Array.isArray(flowExits)) {
              for (const ex of flowExits as any[]) {
                const k = (ex && ex.locationId) ? String(ex.locationId) : '';
                if (!k) continue;
                if (!grouped[k]) grouped[k] = [];
                grouped[k].push(ex);
              }
            }
            const fromGrouped = grouped[loc.id];
            const fromMapArr = exitsMap[loc.id];
            const fromLoc = Array.isArray(loc.exits) ? (loc.exits as any[]) : [];
            const outs: any[] = (Array.isArray(fromGrouped) && fromGrouped.length > 0)
              ? fromGrouped
              : ((Array.isArray(fromMapArr) && fromMapArr.length > 0) ? fromMapArr : fromLoc);
            const locsForLookup: any[] = Array.isArray(game?.locations) ? (game.locations as any[]) : [];
            return (
              <div key={loc.id} className="card" style={{ padding: 10 }}>
                <div style={{ fontWeight: 600 }}>{loc.title}</div>
                {Array.isArray(outs) && outs.length > 0 ? (
                  <ul style={{ margin: '6px 0 0 16px' }}>
                    {outs.map((ex: any) => {
                      const target = locsForLookup.find((l: any) => l && l.id === ex?.targetLocationId);
                      const exType = ex?.type || '';
                      const label = exType === 'TRIGGER' ? (ex?.triggerText || 'триггер') : (exType === 'GAMEOVER' ? 'GAMEOVER' : (ex?.buttonText || 'кнопка'));
                      return (
                        <li key={ex?.id || Math.random().toString(36)} className="muted">
                          [{exType}] {label} → {target ? target.title : (ex?.targetLocationId ? ex.targetLocationId : '—')}
                        </li>
                      );
                    })}
                  </ul>
                ) : (<div className="muted">Нет выходов</div>)}
              </div>
            );
          })}
        </div>
      </div>
      <div className="card" style={{ padding: 12 }}>
        <h3>Справка</h3>
        <div className="muted" style={{ display: 'grid', gap: 8 }}>
          <div>1) Создайте локации и расставьте порядок (стрелки ↑/↓).</div>
          <div>2) Для каждой локации задайте фон и музыку (загрузите файл или вставьте URL), отредактируйте описание.</div>
          <div>3) В «Выходах/триггерах» настройте переходы: BUTTON — по кнопке, TRIGGER — по ключевой фразе, GAMEOVER — финал.</div>
          <div>4) «Экспорт JSON» — сохранить копию, «Импорт JSON» — загрузить готовый сценарий.</div>
        </div>
      </div>
      <div className="card" style={{ padding: 12 }}>
        <h3>Персонажи</h3>
        <div className="muted">Управление персонажами на отдельной странице «Персонажи». Игровых помечайте флагом isPlayable, NPC — оставляйте выключенным. Поля: роль, голос (voiceId), характер (persona), происхождение (origin), гендер, раса, аватар, описание.</div>
        <Link to="/admin/characters">Открыть персонажей</Link>
        <div style={{ height: 8 }} />
        <CharactersInlineEditor gameId={game.id} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={save} disabled={saving}>{saving ? 'Сохранение...' : 'Сохранить'}</button>
        <a href={`/admin/games`}><button>Назад к списку</button></a>
      </div>
    </div>
  );
};

type User = {
  id: string; firstName: string; lastName: string; tgUsername?: string; tgId?: string; subscriptionType?: 'free' | 'premium' | 'trial'; status: 'active' | 'blocked'; registeredAt: string; balance: number; referrerTgId?: string; referralsCount: number; subscriptionUntil?: string; lastSeenAt?: string;
};

const UsersPage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<{ data: User[]; total: number; page: number; limit: number } | null>(null);
  const q = params.get('q') || '';
  const page = Number(params.get('page') || 1);
  const limit = Number(params.get('limit') || 20);
  const status = params.get('status') || '';
  const subscriptionType = params.get('subscriptionType') || '';
  const dateFrom = params.get('dateFrom') || '';
  const dateTo = params.get('dateTo') || '';

  const load = async () => {
    const qs = new URLSearchParams({ q, page: String(page), limit: String(limit) });
    if (status) qs.set('status', status);
    if (subscriptionType) qs.set('subscriptionType', subscriptionType);
    if (dateFrom) qs.set('dateFrom', dateFrom);
    if (dateTo) qs.set('dateTo', dateTo);
    const res = await fetch(`${API}/users?${qs.toString()}`);
    setData(await res.json());
  };
  useEffect(() => { load(); }, [q, page, limit, status, subscriptionType, dateFrom, dateTo]);

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => next.set(k, v));
    setParams(next);
  };

  const totalPages = useMemo(() => (data ? Math.ceil(data.total / data.limit) : 1), [data]);

  const onExportCsv = () => {
    const qs = new URLSearchParams({ q, status, subscriptionType, dateFrom, dateTo });
    window.open(`${API}/users.csv?${qs.toString()}`);
  };

  const [editing, setEditing] = useState<User | null>(null);
  const [patch, setPatch] = useState<Partial<User>>({});
  const save = async () => {
    if (!editing) return;
    await fetch(`${API}/users/${editing.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    setEditing(null);
    setPatch({});
    load();
  };

  return (
    <div style={{ padding: 16, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 12 }}>
        <Link to="/admin">Дашборд</Link>
        <Link to="/admin/games">Игры</Link>
        <Link to="/admin/users">Пользователи</Link>
        <Link to="/admin/characters">Персонажи</Link>
        <Link to="/admin/feedback">Отзывы</Link>
      </div>
      <h2>Пользователи</h2>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 140px 160px 160px auto', gap: 8 }}>
        <input placeholder="Поиск (имя, ник, tgId)" defaultValue={q} onChange={(e) => update({ q: e.target.value, page: '1' })} />
        <select value={status} onChange={(e) => update({ status: e.target.value, page: '1' })}>
          <option value="">Статус: любой</option>
          <option value="active">active</option>
          <option value="blocked">blocked</option>
        </select>
        <select value={subscriptionType} onChange={(e) => update({ subscriptionType: e.target.value, page: '1' })}>
          <option value="">Подписка: любая</option>
          <option value="free">free</option>
          <option value="premium">premium</option>
          <option value="trial">trial</option>
        </select>
        <input type="date" value={dateFrom} onChange={(e) => update({ dateFrom: e.target.value, page: '1' })} />
        <input type="date" value={dateTo} onChange={(e) => update({ dateTo: e.target.value, page: '1' })} />
        <button onClick={onExportCsv}>Экспорт CSV</button>
      </div>
      <div className="card" style={{ padding: 12 }}>
        {!data ? 'Загрузка...' : (
          <table style={{ width: '100%', borderSpacing: 0 }}>
            <thead>
              <tr>
                <th>#</th>
                <th>Имя</th>
                <th>Фамилия</th>
                <th>Ник</th>
                <th>tgId</th>
                <th>Тип</th>
                <th>Статус</th>
                <th>Регистрация</th>
                <th>Баланс</th>
                <th>Рефералов</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((u) => (
                <tr key={u.id}>
                  <td>{u.id}</td>
                  <td>{u.firstName}</td>
                  <td>{u.lastName}</td>
                  <td>{u.tgUsername}</td>
                  <td>{u.tgId}</td>
                  <td>{u.subscriptionType}</td>
                  <td>{u.status}</td>
                  <td>{new Date(u.registeredAt).toLocaleString('ru-RU')}</td>
                  <td>{u.balance}</td>
                  <td>{u.referralsCount}</td>
                  <td><button onClick={() => { setEditing(u); setPatch({}); }}>Редактировать</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>Назад</button>
        <div>Стр. {page} / {totalPages}</div>
        <button disabled={page >= totalPages} onClick={() => update({ page: String(page + 1) })}>Вперёд</button>
      </div>

      {editing && (
        <div className="card" style={{ padding: 12 }}>
          <h3>Редактирование пользователя #{editing.id}</h3>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <select value={patch.status ?? editing.status} onChange={(e) => setPatch({ ...patch, status: e.target.value as any })}>
              <option value="active">active</option>
              <option value="blocked">blocked</option>
            </select>
            <select value={patch.subscriptionType ?? (editing.subscriptionType || '')} onChange={(e) => setPatch({ ...patch, subscriptionType: (e.target.value || undefined) as any })}>
              <option value="">— subscriptionType —</option>
              <option value="free">free</option>
              <option value="premium">premium</option>
              <option value="trial">trial</option>
            </select>
            <input type="number" placeholder="Баланс" defaultValue={editing.balance} onChange={(e) => setPatch({ ...patch, balance: Number(e.target.value) })} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={save}>Сохранить</button>
            <button onClick={() => setEditing(null)}>Отмена</button>
          </div>
        </div>
      )}
    </div>
  );
};

const FeedbackPage: React.FC = () => {
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => { fetch(`${API}/feedback`).then(async (r) => setItems(await r.json())); }, []);
  return (
    <div style={{ padding: 16, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 12 }}>
        <Link to="/admin">Дашборд</Link>
        <Link to="/admin/games">Игры</Link>
        <Link to="/admin/users">Пользователи</Link>
        <Link to="/admin/characters">Персонажи</Link>
        <Link to="/admin/feedback">Отзывы</Link>
      </div>
      <h2>Отзывы</h2>
      <div className="card" style={{ padding: 12 }}>
        <ul>
          {items.map((f) => (
            <li key={f.id}>[{new Date(f.createdAt).toLocaleString('ru-RU')}] user={f.userId} game={f.gameId} rating={f.rating} — {f.comment}</li>
          ))}
        </ul>
      </div>
    </div>
  );
};

type Character = { 
  id: string; 
  name: string; 
  gender?: string; 
  race?: string; 
  avatarUrl: string; 
  description?: string; 
  rating?: number; 
  gameId?: string;
  // D&D 5e Stats
  level?: number;
  class?: string;
  hp?: number;
  maxHp?: number;
  ac?: number;
  str?: number;
  dex?: number;
  con?: number;
  int?: number;
  wis?: number;
  cha?: number;
  isPlayable?: boolean;
};
const CharactersPage: React.FC = () => {
  const [list, setList] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterPlayable, setFilterPlayable] = useState<'all' | 'playable' | 'npc'>('all');
  const [editingStats, setEditingStats] = useState<Record<string, Partial<Character>>>({});
  const [form, setForm] = useState<Partial<Character>>({ 
    name: '', 
    avatarUrl: 'https://picsum.photos/seed/new_char/80/80', 
    gender: 'Мужской', 
    race: 'Раса',
    level: 1,
    class: '',
    hp: 10,
    maxHp: 10,
    ac: 10,
    str: 10,
    dex: 10,
    con: 10,
    int: 10,
    wis: 10,
    cha: 10,
  });
  
  const getDndModifier = (score: number) => Math.floor((score - 10) / 2);
  
  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/admin/characters`);
      if (!res.ok) throw new Error('Failed to load');
      setList(await res.json());
    } catch (e) {
      console.error('Failed to load characters:', e);
      alert('Ошибка загрузки персонажей');
    } finally {
      setLoading(false);
    }
  };
  
  useEffect(() => { load(); }, []);
  
  const onCreate = async () => {
    if (!form.name?.trim()) {
      alert('Введите имя персонажа');
      return;
    }
    setSaving('create');
    try {
      const payload = { 
        name: form.name || 'Новый персонаж', 
        avatarUrl: form.avatarUrl || 'https://picsum.photos/seed/new_char/80/80', 
        gender: form.gender, 
        race: form.race, 
        description: form.description, 
        rating: Number(form.rating) || 5, 
        gameId: form.gameId,
        level: Math.max(1, Math.min(20, Number(form.level) || 1)),
        class: form.class,
        hp: Math.max(1, Number(form.hp) || 10),
        maxHp: Math.max(1, Number(form.maxHp) || 10),
        ac: Math.max(0, Number(form.ac) || 10),
        str: Math.max(1, Math.min(30, Number(form.str) || 10)),
        dex: Math.max(1, Math.min(30, Number(form.dex) || 10)),
        con: Math.max(1, Math.min(30, Number(form.con) || 10)),
        int: Math.max(1, Math.min(30, Number(form.int) || 10)),
        wis: Math.max(1, Math.min(30, Number(form.wis) || 10)),
        cha: Math.max(1, Math.min(30, Number(form.cha) || 10)),
      };
      const res = await fetch(`${API}/characters`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error('Failed to create');
      // Сброс формы
      setForm({ 
        name: '', 
        avatarUrl: 'https://picsum.photos/seed/new_char/80/80', 
        gender: 'Мужской', 
        race: 'Раса',
        level: 1,
        class: '',
        hp: 10,
        maxHp: 10,
        ac: 10,
        str: 10,
        dex: 10,
        con: 10,
        int: 10,
        wis: 10,
        cha: 10,
      });
      await load();
    } catch (e) {
      console.error('Failed to create character:', e);
      alert('Ошибка создания персонажа');
    } finally {
      setSaving(null);
    }
  };
  
  const onDelete = async (id: string, name: string) => {
    if (!confirm(`Удалить персонажа "${name}"?`)) return;
    try {
      const res = await fetch(`${API}/characters/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      await load();
    } catch (e) {
      console.error('Failed to delete character:', e);
      alert('Ошибка удаления персонажа');
    }
  };
  
  const onUpdateStat = async (id: string, field: string, value: any) => {
    setSaving(id);
    try {
      const res = await fetch(`${API}/characters/${id}`, { 
        method: 'PATCH', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ [field]: value }) 
      });
      if (!res.ok) throw new Error('Failed to update');
      await load();
    } catch (e) {
      console.error('Failed to update character:', e);
      alert('Ошибка обновления персонажа');
    } finally {
      setSaving(null);
    }
  };
  
  const onUpdateStats = async (id: string, stats: Partial<Character>) => {
    setSaving(id);
    try {
      // Валидация
      const validated: any = {};
      if (stats.level !== undefined) validated.level = Math.max(1, Math.min(20, Number(stats.level) || 1));
      if (stats.hp !== undefined) validated.hp = Math.max(1, Number(stats.hp) || 10);
      if (stats.maxHp !== undefined) validated.maxHp = Math.max(1, Number(stats.maxHp) || 10);
      if (stats.ac !== undefined) validated.ac = Math.max(0, Number(stats.ac) || 10);
      ['str', 'dex', 'con', 'int', 'wis', 'cha'].forEach(stat => {
        if (stats[stat as keyof Character] !== undefined) {
          validated[stat] = Math.max(1, Math.min(30, Number(stats[stat as keyof Character]) || 10));
        }
      });
      if (stats.class !== undefined) validated.class = stats.class || null;
      
      const res = await fetch(`${API}/characters/${id}`, { 
        method: 'PATCH', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify(validated) 
      });
      if (!res.ok) throw new Error('Failed to update');
      setEditingStats({});
      await load();
    } catch (e) {
      console.error('Failed to update character:', e);
      alert('Ошибка обновления персонажа');
    } finally {
      setSaving(null);
    }
  };
  
  const filteredList = list.filter(c => {
    const matchesSearch = !search || 
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.race?.toLowerCase().includes(search.toLowerCase()) ||
      c.class?.toLowerCase().includes(search.toLowerCase());
    const matchesFilter = filterPlayable === 'all' || 
      (filterPlayable === 'playable' && c.isPlayable) ||
      (filterPlayable === 'npc' && !c.isPlayable);
    return matchesSearch && matchesFilter;
  });
  
  const playableCount = list.filter(c => c.isPlayable).length;
  const npcCount = list.filter(c => !c.isPlayable).length;

  return (
    <div style={{ padding: 16, display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', gap: 12 }}>
        <Link to="/admin">Дашборд</Link>
        <Link to="/admin/games">Игры</Link>
        <Link to="/admin/users">Пользователи</Link>
        <Link to="/admin/characters">Персонажи</Link>
        <Link to="/admin/feedback">Отзывы</Link>
      </div>
      <h2>Персонажи ({list.length})</h2>
      
      {/* Фильтры и поиск */}
      <div className="card" style={{ padding: 12 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input 
            placeholder="Поиск по имени, расе, классу..." 
            value={search} 
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button 
              onClick={() => setFilterPlayable('all')}
              style={{ backgroundColor: filterPlayable === 'all' ? '#007bff' : '#f0f0f0', color: filterPlayable === 'all' ? 'white' : 'black' }}
            >
              Все ({list.length})
            </button>
            <button 
              onClick={() => setFilterPlayable('playable')}
              style={{ backgroundColor: filterPlayable === 'playable' ? '#007bff' : '#f0f0f0', color: filterPlayable === 'playable' ? 'white' : 'black' }}
            >
              Игровые ({playableCount})
            </button>
            <button 
              onClick={() => setFilterPlayable('npc')}
              style={{ backgroundColor: filterPlayable === 'npc' ? '#007bff' : '#f0f0f0', color: filterPlayable === 'npc' ? 'white' : 'black' }}
            >
              NPC ({npcCount})
            </button>
          </div>
        </div>
      </div>
      
      <div className="card" style={{ padding: 12 }}>
        <h3>Создать персонажа</h3>
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <input placeholder="Имя" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="Аватар URL" value={form.avatarUrl || ''} onChange={(e) => setForm({ ...form, avatarUrl: e.target.value })} />
          <input placeholder="Раса" value={form.race || ''} onChange={(e) => setForm({ ...form, race: e.target.value })} />
          <input placeholder="Гендер" value={form.gender || ''} onChange={(e) => setForm({ ...form, gender: e.target.value })} />
          <input placeholder="Игра (gameId)" value={form.gameId || ''} onChange={(e) => setForm({ ...form, gameId: e.target.value })} />
          <input placeholder="Рейтинг" type="number" value={form.rating as number | undefined} onChange={(e) => setForm({ ...form, rating: Number(e.target.value) })} />
          <textarea placeholder="Описание" value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div style={{ marginTop: 12, padding: 8, backgroundColor: '#f5f5f5', borderRadius: 4 }}>
          <h4 style={{ margin: '0 0 8px 0' }}>D&D 5e Статы</h4>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(6, 1fr)' }}>
            <div>
              <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Уровень</label>
              <input type="number" placeholder="1" value={form.level || ''} onChange={(e) => setForm({ ...form, level: Number(e.target.value) })} />
            </div>
            <div>
              <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Класс</label>
              <input placeholder="Воин" value={form.class || ''} onChange={(e) => setForm({ ...form, class: e.target.value })} />
            </div>
            <div>
              <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>HP</label>
              <input type="number" placeholder="10" value={form.hp || ''} onChange={(e) => setForm({ ...form, hp: Number(e.target.value) })} />
            </div>
            <div>
              <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Max HP</label>
              <input type="number" placeholder="10" value={form.maxHp || ''} onChange={(e) => setForm({ ...form, maxHp: Number(e.target.value) })} />
            </div>
            <div>
              <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>AC</label>
              <input type="number" placeholder="10" value={form.ac || ''} onChange={(e) => setForm({ ...form, ac: Number(e.target.value) })} />
            </div>
          </div>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(6, 1fr)', marginTop: 8 }}>
            <div>
              <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>STR</label>
              <input type="number" placeholder="10" value={form.str || ''} onChange={(e) => setForm({ ...form, str: Number(e.target.value) })} />
            </div>
            <div>
              <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>DEX</label>
              <input type="number" placeholder="10" value={form.dex || ''} onChange={(e) => setForm({ ...form, dex: Number(e.target.value) })} />
            </div>
            <div>
              <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>CON</label>
              <input type="number" placeholder="10" value={form.con || ''} onChange={(e) => setForm({ ...form, con: Number(e.target.value) })} />
            </div>
            <div>
              <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>INT</label>
              <input type="number" placeholder="10" value={form.int || ''} onChange={(e) => setForm({ ...form, int: Number(e.target.value) })} />
            </div>
            <div>
              <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>WIS</label>
              <input type="number" placeholder="10" value={form.wis || ''} onChange={(e) => setForm({ ...form, wis: Number(e.target.value) })} />
            </div>
            <div>
              <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>CHA</label>
              <input type="number" placeholder="10" value={form.cha || ''} onChange={(e) => setForm({ ...form, cha: Number(e.target.value) })} />
            </div>
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <button onClick={onCreate} disabled={saving === 'create'}>
            {saving === 'create' ? 'Создание...' : 'Создать'}
          </button>
        </div>
      </div>
      <div className="card" style={{ padding: 12 }}>
        <h3>Список персонажей {filteredList.length !== list.length ? `(${filteredList.length} из ${list.length})` : ''}</h3>
        {loading ? 'Загрузка...' : filteredList.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: '#666' }}>
            {search || filterPlayable !== 'all' ? 'Персонажи не найдены' : 'Нет персонажей'}
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {filteredList.map((c) => {
              const editing = editingStats[c.id] || {};
              const isSaving = saving === c.id;
              const modStr = getDndModifier(c.str || 10);
              const modDex = getDndModifier(c.dex || 10);
              const modCon = getDndModifier(c.con || 10);
              const modInt = getDndModifier(c.int || 10);
              const modWis = getDndModifier(c.wis || 10);
              const modCha = getDndModifier(c.cha || 10);
              
              return (
                <li key={c.id} className="card" style={{ padding: 12, display: 'grid', gap: 8, opacity: isSaving ? 0.6 : 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <img src={c.avatarUrl} alt="a" width={48} height={48} style={{ borderRadius: 24, objectFit: 'cover' }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input 
                          defaultValue={c.name} 
                          onBlur={(e) => onUpdateStat(c.id, 'name', e.target.value)}
                          style={{ fontWeight: 'bold', border: 'none', borderBottom: '1px solid #ddd', padding: '2px 4px', fontSize: 16 }}
                        />
                        {c.isPlayable && <span style={{ fontSize: 11, backgroundColor: '#28a745', color: 'white', padding: '2px 6px', borderRadius: 4 }}>ИГРОВОЙ</span>}
                        {!c.isPlayable && <span style={{ fontSize: 11, backgroundColor: '#6c757d', color: 'white', padding: '2px 6px', borderRadius: 4 }}>NPC</span>}
                      </div>
                      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                        <input 
                          defaultValue={c.race || ''} 
                          onBlur={(e) => onUpdateStat(c.id, 'race', e.target.value || null)}
                          placeholder="Раса"
                          style={{ border: 'none', borderBottom: '1px dashed #ccc', padding: '1px 2px', fontSize: 12, width: 80 }}
                        />
                        {' • '}
                        <input 
                          defaultValue={c.gender || ''} 
                          onBlur={(e) => onUpdateStat(c.id, 'gender', e.target.value || null)}
                          placeholder="Гендер"
                          style={{ border: 'none', borderBottom: '1px dashed #ccc', padding: '1px 2px', fontSize: 12, width: 80 }}
                        />
                        {c.class && ` • ${c.class} (Ур.${c.level || 1})`}
                        {c.gameId && ` • Игра: ${c.gameId.slice(0, 8)}...`}
                      </div>
                    </div>
                    {isSaving && <span style={{ fontSize: 12, color: '#666' }}>Сохранение...</span>}
                    <button onClick={() => onDelete(c.id, c.name)} className="header-btn danger" disabled={isSaving}>Удалить</button>
                  </div>
                  
                  {/* Статы с модификаторами */}
                  <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(6, 1fr)', padding: 8, backgroundColor: '#f9f9f9', borderRadius: 4 }}>
                    <div>
                      <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>HP / Max HP</label>
                      <div style={{ display: 'flex', gap: 4 }}>
                      <input 
                        type="number" 
                        defaultValue={c.hp ?? 10} 
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setEditingStats({ ...editingStats, [c.id]: { ...editing, hp: val } });
                        }}
                        onBlur={(e) => {
                          const val = Number(e.target.value);
                          if (val !== (c.hp ?? 10)) onUpdateStat(c.id, 'hp', val);
                        }}
                        style={{ width: '50%' }} 
                        min={1}
                      />
                      <input 
                        type="number" 
                        defaultValue={c.maxHp ?? 10} 
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setEditingStats({ ...editingStats, [c.id]: { ...editing, maxHp: val } });
                        }}
                        onBlur={(e) => {
                          const val = Number(e.target.value);
                          if (val !== (c.maxHp ?? 10)) onUpdateStat(c.id, 'maxHp', val);
                        }}
                        style={{ width: '50%' }} 
                        min={1}
                      />
                      </div>
                    </div>
                    <div>
                      <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>AC</label>
                      <input 
                        type="number" 
                        defaultValue={c.ac ?? 10} 
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setEditingStats({ ...editingStats, [c.id]: { ...editing, ac: val } });
                        }}
                        onBlur={(e) => {
                          const val = Number(e.target.value);
                          if (val !== (c.ac ?? 10)) onUpdateStat(c.id, 'ac', val);
                        }}
                        style={{ width: '100%' }} 
                        min={0}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>STR <span style={{ color: '#666' }}>({modStr >= 0 ? '+' : ''}{modStr})</span></label>
                      <input 
                        type="number" 
                        defaultValue={c.str ?? 10} 
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setEditingStats({ ...editingStats, [c.id]: { ...editing, str: val } });
                        }}
                        onBlur={(e) => {
                          const val = Number(e.target.value);
                          if (val !== (c.str ?? 10)) onUpdateStat(c.id, 'str', val);
                        }}
                        style={{ width: '100%' }} 
                        min={1}
                        max={30}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>DEX <span style={{ color: '#666' }}>({modDex >= 0 ? '+' : ''}{modDex})</span></label>
                      <input 
                        type="number" 
                        defaultValue={c.dex ?? 10} 
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setEditingStats({ ...editingStats, [c.id]: { ...editing, dex: val } });
                        }}
                        onBlur={(e) => {
                          const val = Number(e.target.value);
                          if (val !== (c.dex ?? 10)) onUpdateStat(c.id, 'dex', val);
                        }}
                        style={{ width: '100%' }} 
                        min={1}
                        max={30}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>CON <span style={{ color: '#666' }}>({modCon >= 0 ? '+' : ''}{modCon})</span></label>
                      <input 
                        type="number" 
                        defaultValue={c.con ?? 10} 
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setEditingStats({ ...editingStats, [c.id]: { ...editing, con: val } });
                        }}
                        onBlur={(e) => {
                          const val = Number(e.target.value);
                          if (val !== (c.con ?? 10)) onUpdateStat(c.id, 'con', val);
                        }}
                        style={{ width: '100%' }} 
                        min={1}
                        max={30}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>INT <span style={{ color: '#666' }}>({modInt >= 0 ? '+' : ''}{modInt})</span></label>
                      <input 
                        type="number" 
                        defaultValue={c.int ?? 10} 
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setEditingStats({ ...editingStats, [c.id]: { ...editing, int: val } });
                        }}
                        onBlur={(e) => {
                          const val = Number(e.target.value);
                          if (val !== (c.int ?? 10)) onUpdateStat(c.id, 'int', val);
                        }}
                        style={{ width: '100%' }} 
                        min={1}
                        max={30}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>WIS <span style={{ color: '#666' }}>({modWis >= 0 ? '+' : ''}{modWis})</span></label>
                      <input 
                        type="number" 
                        defaultValue={c.wis ?? 10} 
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setEditingStats({ ...editingStats, [c.id]: { ...editing, wis: val } });
                        }}
                        onBlur={(e) => {
                          const val = Number(e.target.value);
                          if (val !== (c.wis ?? 10)) onUpdateStat(c.id, 'wis', val);
                        }}
                        style={{ width: '100%' }} 
                        min={1}
                        max={30}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>CHA <span style={{ color: '#666' }}>({modCha >= 0 ? '+' : ''}{modCha})</span></label>
                      <input 
                        type="number" 
                        defaultValue={c.cha ?? 10} 
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setEditingStats({ ...editingStats, [c.id]: { ...editing, cha: val } });
                        }}
                        onBlur={(e) => {
                          const val = Number(e.target.value);
                          if (val !== (c.cha ?? 10)) onUpdateStat(c.id, 'cha', val);
                        }}
                        style={{ width: '100%' }} 
                        min={1}
                        max={30}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Уровень</label>
                      <input 
                        type="number" 
                        defaultValue={c.level ?? 1} 
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setEditingStats({ ...editingStats, [c.id]: { ...editing, level: val } });
                        }}
                        onBlur={(e) => {
                          const val = Number(e.target.value);
                          if (val !== (c.level ?? 1)) onUpdateStat(c.id, 'level', val);
                        }}
                        style={{ width: '100%' }} 
                        min={1}
                        max={20}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Класс</label>
                      <input 
                        defaultValue={c.class ?? ''} 
                        onChange={(e) => {
                          setEditingStats({ ...editingStats, [c.id]: { ...editing, class: e.target.value } });
                        }}
                        onBlur={(e) => {
                          const val = e.target.value;
                          if (val !== (c.class || '')) onUpdateStat(c.id, 'class', val || null);
                        }}
                        style={{ width: '100%' }} 
                        placeholder="Воин, Маг..."
                      />
                    </div>
                    <div style={{ gridColumn: 'span 4' }}>
                      <button 
                        onClick={() => onUpdateStats(c.id, editing)}
                        disabled={Object.keys(editing).length === 0 || isSaving}
                        style={{ width: '100%', padding: '6px', fontSize: 12 }}
                      >
                        {isSaving ? 'Сохранение...' : 'Сохранить все изменения'}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

// --- Editions Editor ---
const EditionsEditor: React.FC<{ gameId: string }> = ({ gameId }) => {
  const [list, setList] = useState<Array<{ id: string; name: string; description: string; price: number; badge?: string | null }>>([]);
  const [form, setForm] = useState<{ name: string; description: string; price: number; badge?: string }>({ name: '', description: '', price: 0, badge: '' });
  const load = async () => {
    const r = await fetch(`${API}/games/${gameId}/editions`);
    setList(await r.json());
  };
  useEffect(() => { if (gameId) load(); }, [gameId]);
  const add = async () => {
    await fetch(`${API}/games/${gameId}/editions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
    setForm({ name: '', description: '', price: 0, badge: '' });
    load();
  };
  const patch = async (id: string, p: any) => {
    await fetch(`${API}/editions/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
    load();
  };
  const del = async (id: string) => {
    await fetch(`${API}/editions/${id}`, { method: 'DELETE' });
    load();
  };
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '1fr 2fr 120px 1fr auto' }}>
        <input placeholder="Название" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="Описание" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <input type="number" placeholder="Цена" value={form.price} onChange={(e) => setForm({ ...form, price: Number(e.target.value) })} />
        <input placeholder="Бейдж (опц.)" value={form.badge || ''} onChange={(e) => setForm({ ...form, badge: e.target.value })} />
        <button onClick={add}>Добавить</button>
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
        {list.map((e) => (
          <li key={e.id} className="card" style={{ padding: 8, display: 'grid', gap: 6, gridTemplateColumns: '1fr 2fr 120px 1fr auto' }}>
            <input defaultValue={e.name} onBlur={(ev) => patch(e.id, { name: ev.currentTarget.value })} />
            <input defaultValue={e.description} onBlur={(ev) => patch(e.id, { description: ev.currentTarget.value })} />
            <input type="number" defaultValue={e.price} onBlur={(ev) => patch(e.id, { price: Number(ev.currentTarget.value) })} />
            <input defaultValue={e.badge || ''} onBlur={(ev) => patch(e.id, { badge: ev.currentTarget.value || null })} />
            <button className="header-btn danger" onClick={() => del(e.id)}>Удалить</button>
          </li>
        ))}
      </ul>
    </div>
  );
};

// --- Characters Inline Editor in Scenario ---
const CharactersInlineEditor: React.FC<{ gameId: string }> = ({ gameId }) => {
  const [list, setList] = useState<Array<any>>([]);
  const [form, setForm] = useState<Partial<any>>({
    name: '',
    avatarUrl: '',
    race: '',
    gender: '',
    voiceId: '',
    persona: '',
    origin: '',
    role: '',
    isPlayable: false,
    abilities: '',
    level: 1,
    class: '',
    hp: 10,
    maxHp: 10,
    ac: 10,
    str: 10,
    dex: 10,
    con: 10,
    int: 10,
    wis: 10,
    cha: 10,
  });
  const load = async () => {
    const r = await fetch(`${API}/characters?gameId=${encodeURIComponent(gameId)}`);
    setList(await r.json());
  };
  useEffect(() => { if (gameId) load(); }, [gameId]);
  const add = async () => {
    const payload = { 
      ...form, 
      gameId,
      level: Number(form.level) || 1,
      hp: Number(form.hp) || 10,
      maxHp: Number(form.maxHp) || 10,
      ac: Number(form.ac) || 10,
      str: Number(form.str) || 10,
      dex: Number(form.dex) || 10,
      con: Number(form.con) || 10,
      int: Number(form.int) || 10,
      wis: Number(form.wis) || 10,
      cha: Number(form.cha) || 10,
    };
    await fetch(`${API}/characters`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    setForm({ name: '', avatarUrl: '', race: '', gender: '', voiceId: '', persona: '', origin: '', role: '', isPlayable: false, abilities: '', level: 1, class: '', hp: 10, maxHp: 10, ac: 10, str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 });
    load();
  };
  const patch = async (id: string, p: any) => {
    await fetch(`${API}/characters/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
    load();
  };
  const del = async (id: string) => {
    await fetch(`${API}/characters/${id}`, { method: 'DELETE' });
    load();
  };
  const onUploadAvatar = async (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(`${API}/admin/upload`, { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({} as any));
    if (r.ok && j.url) await patch(id, { avatarUrl: j.url });
  };
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div className="card" style={{ padding: 8 }}>
        <h4>Добавить персонажа / NPC</h4>
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr 1fr auto' }}>
          <input placeholder="Имя" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="Роль (напр. NPC, Guide)" value={form.role || ''} onChange={(e) => setForm({ ...form, role: e.target.value })} />
          <input placeholder="Раса" value={form.race || ''} onChange={(e) => setForm({ ...form, race: e.target.value })} />
          <input placeholder="Гендер" value={form.gender || ''} onChange={(e) => setForm({ ...form, gender: e.target.value })} />
          <input placeholder="Голос (voiceId)" value={form.voiceId || ''} onChange={(e) => setForm({ ...form, voiceId: e.target.value })} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={Boolean(form.isPlayable)} onChange={(e) => setForm({ ...form, isPlayable: e.target.checked })} /> Игровой
          </label>
          <button onClick={add}>Добавить</button>
        </div>
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '1fr 1fr' }}>
          <input placeholder="Аватар URL" value={form.avatarUrl || ''} onChange={(e) => setForm({ ...form, avatarUrl: e.target.value })} />
          <input placeholder="Происхождение (origin)" value={form.origin || ''} onChange={(e) => setForm({ ...form, origin: e.target.value })} />
          <input placeholder="Характер (persona)" value={form.persona || ''} onChange={(e) => setForm({ ...form, persona: e.target.value })} />
          <textarea placeholder="Способности (по одной в строке)" value={form.abilities || ''} onChange={(e) => setForm({ ...form, abilities: e.target.value })} />
        </div>
        <div style={{ marginTop: 8, padding: 8, backgroundColor: '#f5f5f5', borderRadius: 4 }}>
          <h4 style={{ margin: '0 0 8px 0', fontSize: 14 }}>D&D 5e Статы</h4>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(6, 1fr)' }}>
            <div>
              <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Уровень</label>
              <input type="number" placeholder="1" value={form.level || ''} onChange={(e) => setForm({ ...form, level: Number(e.target.value) })} />
            </div>
            <div>
              <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Класс</label>
              <input placeholder="Воин" value={form.class || ''} onChange={(e) => setForm({ ...form, class: e.target.value })} />
            </div>
            <div>
              <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>HP</label>
              <input type="number" placeholder="10" value={form.hp || ''} onChange={(e) => setForm({ ...form, hp: Number(e.target.value) })} />
            </div>
            <div>
              <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Max HP</label>
              <input type="number" placeholder="10" value={form.maxHp || ''} onChange={(e) => setForm({ ...form, maxHp: Number(e.target.value) })} />
            </div>
            <div>
              <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>AC</label>
              <input type="number" placeholder="10" value={form.ac || ''} onChange={(e) => setForm({ ...form, ac: Number(e.target.value) })} />
            </div>
          </div>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(6, 1fr)', marginTop: 8 }}>
            <div>
              <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>STR</label>
              <input type="number" placeholder="10" value={form.str || ''} onChange={(e) => setForm({ ...form, str: Number(e.target.value) })} />
            </div>
            <div>
              <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>DEX</label>
              <input type="number" placeholder="10" value={form.dex || ''} onChange={(e) => setForm({ ...form, dex: Number(e.target.value) })} />
            </div>
            <div>
              <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>CON</label>
              <input type="number" placeholder="10" value={form.con || ''} onChange={(e) => setForm({ ...form, con: Number(e.target.value) })} />
            </div>
            <div>
              <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>INT</label>
              <input type="number" placeholder="10" value={form.int || ''} onChange={(e) => setForm({ ...form, int: Number(e.target.value) })} />
            </div>
            <div>
              <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>WIS</label>
              <input type="number" placeholder="10" value={form.wis || ''} onChange={(e) => setForm({ ...form, wis: Number(e.target.value) })} />
            </div>
            <div>
              <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>CHA</label>
              <input type="number" placeholder="10" value={form.cha || ''} onChange={(e) => setForm({ ...form, cha: Number(e.target.value) })} />
            </div>
          </div>
        </div>
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
        {list.map((c) => (
          <li key={c.id} className="card" style={{ padding: 8, display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <img src={c.avatarUrl} alt="a" width={48} height={48} style={{ borderRadius: 24, objectFit: 'cover' }} />
              <input defaultValue={c.name} onBlur={(e) => patch(c.id, { name: e.currentTarget.value })} />
              <input defaultValue={c.role || ''} onBlur={(e) => patch(c.id, { role: e.currentTarget.value || null })} placeholder="Роль" />
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" defaultChecked={Boolean(c.isPlayable)} onChange={(e) => patch(c.id, { isPlayable: e.target.checked })} /> Игровой
              </label>
              <button className="header-btn danger" onClick={() => del(c.id)} style={{ marginLeft: 'auto' }}>Удалить</button>
            </div>
            <div style={{ display: 'grid', gap: 6, gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr' }}>
              <input defaultValue={c.race || ''} onBlur={(e) => patch(c.id, { race: e.currentTarget.value || null })} placeholder="Раса" />
              <input defaultValue={c.gender || ''} onBlur={(e) => patch(c.id, { gender: e.currentTarget.value || null })} placeholder="Гендер" />
              <input defaultValue={c.voiceId || ''} onBlur={(e) => patch(c.id, { voiceId: e.currentTarget.value || null })} placeholder="Голос (voiceId)" />
              <input defaultValue={c.origin || ''} onBlur={(e) => patch(c.id, { origin: e.currentTarget.value || null })} placeholder="Происхождение" />
              <input defaultValue={c.persona || ''} onBlur={(e) => patch(c.id, { persona: e.currentTarget.value || null })} placeholder="Характер" />
            </div>
            <div>
              <textarea defaultValue={c.abilities || ''} placeholder="Способности (по одной в строке)" onBlur={(e) => patch(c.id, { abilities: e.currentTarget.value || null })} />
            </div>
            <div style={{ padding: 8, backgroundColor: '#f9f9f9', borderRadius: 4 }}>
              <h4 style={{ margin: '0 0 8px 0', fontSize: 14 }}>D&D 5e Статы</h4>
              <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(6, 1fr)' }}>
                <div>
                  <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>HP</label>
                  <input type="number" defaultValue={c.hp || 10} onBlur={(e) => patch(c.id, { hp: Number(e.target.value) })} style={{ width: '100%' }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Max HP</label>
                  <input type="number" defaultValue={c.maxHp || 10} onBlur={(e) => patch(c.id, { maxHp: Number(e.target.value) })} style={{ width: '100%' }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>AC</label>
                  <input type="number" defaultValue={c.ac || 10} onBlur={(e) => patch(c.id, { ac: Number(e.target.value) })} style={{ width: '100%' }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>STR</label>
                  <input type="number" defaultValue={c.str || 10} onBlur={(e) => patch(c.id, { str: Number(e.target.value) })} style={{ width: '100%' }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>DEX</label>
                  <input type="number" defaultValue={c.dex || 10} onBlur={(e) => patch(c.id, { dex: Number(e.target.value) })} style={{ width: '100%' }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>CON</label>
                  <input type="number" defaultValue={c.con || 10} onBlur={(e) => patch(c.id, { con: Number(e.target.value) })} style={{ width: '100%' }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>INT</label>
                  <input type="number" defaultValue={c.int || 10} onBlur={(e) => patch(c.id, { int: Number(e.target.value) })} style={{ width: '100%' }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>WIS</label>
                  <input type="number" defaultValue={c.wis || 10} onBlur={(e) => patch(c.id, { wis: Number(e.target.value) })} style={{ width: '100%' }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>CHA</label>
                  <input type="number" defaultValue={c.cha || 10} onBlur={(e) => patch(c.id, { cha: Number(e.target.value) })} style={{ width: '100%' }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Уровень</label>
                  <input type="number" defaultValue={c.level || 1} onBlur={(e) => patch(c.id, { level: Number(e.target.value) })} style={{ width: '100%' }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Класс</label>
                  <input defaultValue={c.class || ''} onBlur={(e) => patch(c.id, { class: e.target.value || null })} style={{ width: '100%' }} />
                </div>
              </div>
            </div>
            <div>
              <label className="btn">
                Загрузить аватар
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value=''; if (f) void onUploadAvatar(c.id, f); }} />
              </label>
              <input style={{ marginLeft: 8, width: 360 }} defaultValue={c.avatarUrl || ''} placeholder="или URL" onBlur={(e) => patch(c.id, { avatarUrl: e.currentTarget.value || null })} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};

const router = createBrowserRouter([
  { path: '/', element: <div style={{ padding: 16 }}><Link to="/admin">Открыть админку</Link></div> },
  { path: '/admin', element: <DashboardPage /> },
  { path: '/admin/games', element: <GamesPage /> },
  { path: '/admin/scenario', element: <ScenarioPage /> },
  { path: '/admin/users', element: <UsersPage /> },
  { path: '/admin/characters', element: <CharactersPage /> },
  { path: '/admin/feedback', element: <FeedbackPage /> },
]);

const root = createRoot(document.getElementById('root')!);
root.render(<RouterProvider router={router} />);


