import type { Friend, Game, Profile, User, Feedback, SubscriptionPlan, Character } from './types';

let seq = 3;

export const games: Game[] = [
  {
    id: '1',
    title: 'Название игры',
    description:
      'Описание игры, может быть длинным или коротким, переносится на несколько строк.',
    rating: 5.0,
    tags: ['Фэнтези', 'Командные'],
    author: 'Имя автора',
    coverUrl: 'https://picsum.photos/seed/cover/800/360',
    gallery: [
      'https://picsum.photos/seed/thumb_0/200/120',
      'https://picsum.photos/seed/thumb_1/200/120',
      'https://picsum.photos/seed/thumb_2/200/120',
      'https://picsum.photos/seed/thumb_3/200/120',
    ],
    rules:
      'Правила игры, может быть длинным или коротким текстом, который переносится на несколько строк.',
    editions: [
      { id: 'e1', name: 'Эконом издание', description: 'Базовый комплект', price: 990 },
      { id: 'e2', name: 'Стандартное издание', description: 'Оптимальный выбор', price: 1990 },
      { id: 'e3', name: 'Коллекционное издание', description: 'Максимум контента', price: 3990 },
    ],
  },
  {
    id: '2',
    title: 'Другая игра',
    description: 'Ещё одно описание',
    rating: 4.8,
    tags: ['Пазл'],
    author: 'Автор 2',
    coverUrl: 'https://picsum.photos/seed/cover2/800/360',
    gallery: [],
    rules: 'Короткие правила',
    editions: [{ id: 'e1', name: 'Стандарт', description: '—', price: 990 }],
  },
];

export function createGame(data: Omit<Game, 'id'>): Game {
  const game: Game = {
    id: String(seq++),
    title: data.title ?? 'Название игры',
    description: data.description ?? '',
    rating: data.rating ?? 5,
    tags: data.tags ?? [],
    author: data.author ?? 'Автор',
    coverUrl: data.coverUrl ?? '',
    gallery: data.gallery ?? [],
    rules: data.rules ?? '',
    editions: data.editions ?? [],
  };
  games.push(game);
  return game;
}

export function updateGame(id: string, patch: Partial<Omit<Game, 'id'>>): Game | undefined {
  const idx = games.findIndex((g) => g.id === id);
  if (idx === -1) return undefined;
  const updated: Game = { ...(games[idx] as Game), ...patch };
  games[idx] = updated;
  return updated;
}

export function deleteGame(id: string): boolean {
  const idx = games.findIndex((g) => g.id === id);
  if (idx === -1) return false;
  games.splice(idx, 1);
  return true;
}

export const profile: Profile = {
  id: 'u1',
  name: 'name_name',
  avatarUrl: 'https://picsum.photos/seed/avatar/100/100',
  subscriptionUntil: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
  totalEarned: 312432,
  totalFriends: 124,
  autoRenewal: true,
  cardMasked: '***1234',
};

export const friends: Friend[] = Array.from({ length: 18 }).map((_, i) => ({
  id: String(i + 1),
  name: 'Андрей',
  avatarUrl: 'https://picsum.photos/seed/f' + (i + 1) + '/80/80',
}));

// Users storage (no test data)
let userSeq = 1;
export const users: User[] = [];

export const feedbacks: Feedback[] = [];

export const subscriptionPlans: SubscriptionPlan[] = [
  { id: 'p1', title: 'Месяц', description: 'Базовая подписка', price: 299, durationDays: 30 },
  { id: 'p6', title: '6 месяцев', description: 'Выгодно', price: 1499, durationDays: 180, badge: 'Выгодно' },
  { id: 'p12', title: '12 месяцев', description: 'Лучшее предложение', price: 2699, durationDays: 365 },
];

export function createUser(data: Omit<User, 'id'>): User {
  const u: User = {
    id: String(userSeq++),
    firstName: data.firstName ?? '',
    lastName: data.lastName ?? '',
    tgUsername: data.tgUsername,
    tgId: data.tgId,
    subscriptionType: data.subscriptionType,
    status: data.status ?? 'active',
    registeredAt: data.registeredAt ?? new Date().toISOString(),
    balance: data.balance ?? 0,
    referrerTgId: (data as any).referrerTgId, // поле есть в типах, но может отсутствовать в моках
    referralsCount: data.referralsCount ?? 0,
    subscriptionUntil: data.subscriptionUntil,
    lastSeenAt: data.lastSeenAt,
  };
  users.push(u);
  return u;
}
export function updateUser(id: string, patch: Partial<Omit<User, 'id'>>): User | undefined {
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return undefined;
  const updated: User = { ...(users[idx] as User), ...patch };
  users[idx] = updated;
  return updated;
}
export function deleteUser(id: string): boolean {
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return false;
  users.splice(idx, 1);
  return true;
}

// Characters (in-memory)
let charSeq = 1;
export const characters: Character[] = Array.from({ length: 8 }).map((_, i) => ({
  id: String(charSeq++),
  gameId: i % 2 === 0 ? '1' : '2',
  name: 'Персонаж ' + (i + 1),
  gender: i % 2 === 0 ? 'Мужской' : 'Женский',
  race: 'Человек',
  avatarUrl: `https://picsum.photos/seed/char_${i}/80/80`,
  description: 'Описание персонажа...',
  rating: 5,
  level: 1,
  hp: 10,
  maxHp: 10,
  ac: 10,
  str: 10,
  dex: 10,
  con: 10,
  int: 10,
  wis: 10,
  cha: 10,
}));

export function createCharacter(data: Omit<Character, 'id'>): Character {
  const c: Character = { id: String(charSeq++), name: data.name, avatarUrl: data.avatarUrl, description: data.description, gender: data.gender, race: data.race, rating: data.rating, gameId: data.gameId };
  characters.push(c);
  return c;
}
export function updateCharacter(id: string, patch: Partial<Omit<Character, 'id'>>): Character | undefined {
  const idx = characters.findIndex((c) => c.id === id);
  if (idx === -1) return undefined;
  const updated: Character = { ...(characters[idx] as Character), ...patch };
  characters[idx] = updated;
  return updated;
}
export function deleteCharacter(id: string): boolean {
  const idx = characters.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  characters.splice(idx, 1);
  return true;
}


