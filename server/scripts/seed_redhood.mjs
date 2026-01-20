import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function upsertGame() {
  const title = 'DnD: Красная Шапочка — Гонка со временем';
  const existing = await prisma.game.findFirst({ where: { title } });
  if (existing) return existing;

  return prisma.game.create({
    data: {
      title,
      description:
        'Полноценный сценарий по мотивам «Красной Шапочки». Игроки: Красная Шапочка, пёс Жульен, мышь Люси. Цель — добраться до бабушки раньше Волка и спасти её.',
      rating: 5,
      tags: ['dnd', 'сказка', 'приключения', 'фэнтези'],
      author: 'MIRA',
      coverUrl: 'https://picsum.photos/seed/redhood/1200/600',
      rules: 'Кубики: D20 — проверки/бой, D8 — урон, D6 — случайные события. Примеры: общение: D20+харизма (10+ успех), бой: атака D20 (10+ попадание), урон D8; ловкость: D20+ловкость (12+ успех); поиск тайников: D20+интеллект (10+ найдено).',
      gallery: [],
      worldRules:
        'Мир близок к средневековью: деревни, леса, охотники. Волк — проницателен и быстр; у NPC свои мотивы. Секретные предметы усиливают персонажей.',
      gameplayRules:
        'Свободное исследование. Персонажи могут разделяться. Проверки D20 с модификаторами. Сложность: 10 — просто, 12 — средне, 15 — сложно.',
      vkVideoUrl: null,
      promoDescription:
        'Стань героем сказки: спаси бабушку раньше Волка! Играй Красной Шапочкой, Жульеном или Люси.',
      marketplaceLinks: [],
      shelfCategory: 'FANTASY',
      shelfPosition: 1,
      bannerStyle: 'WIDE',
      ageRating: 'G6',
      authorUserId: null,
      status: 'PUBLISHED',
      winCondition: 'Добраться до бабушки раньше Волка и спасти её.',
      loseCondition: 'Волк добрался первым или команда проиграла бой.',
      deathCondition: 'Критический провал в бою/событии при отсутствии спасброска.',
      finalScreenUrl: null,
    },
  });
}

async function seedLocations(gameId) {
  const existing = await prisma.location.findMany({ where: { gameId } });
  if (existing.length > 0) return existing;

  const data = [
    {
      order: 1,
      title: 'Деревня Красной Шапочки',
      description:
        'Уютная, бедная деревня. Площадь с колодцем, кузница Хьюго, трактир «У Синего петуха», огороды. Запах дыма и травы.',
      backgroundUrl: 'https://picsum.photos/seed/village/1280/720',
      musicUrl: 'https://example.com/audio/village.mp3',
      layout: {
        points: [
          {
            name: 'Главная площадь',
            details: ['каменный колодец', 'торговые ряды', 'ржавая подкова (+1 к удаче)'],
          },
          {
            name: 'Кузница Хьюго',
            details: ['горн с пламенем', 'сундук с железом', 'подсказка о тайной тропе'],
          },
          {
            name: 'Трактир «У Синего петуха»',
            details: ['тусклые фонари', 'пьяница Джордж', 'бочка вина'],
          },
          { name: 'Огороды', details: ['капуста', 'чеснок', 'ведро молока у доярки'] },
        ],
        npcs: [
          { name: 'Кузнец Хьюго', item: 'сломанный кинжал', trait: 'прямолинейный' },
          { name: 'Доярка Агата', item: 'бутыль молока (+1 HP)', trait: 'добрая, трусливая' },
          { name: 'Подружка Мэри', item: 'лента (амулет)', trait: 'болтливая' },
          { name: 'Бродяга Томас', item: 'фляга (в записке тайная тропа)', trait: 'хитрый' },
          { name: 'Пьяница Джордж', item: 'хлеб (приманка)', trait: 'жадный' },
        ],
        items: ['Подкова (+1 к удаче)'],
      },
    },
    {
      order: 2,
      title: 'Лес',
      description:
        'Тёмный, густой лес. Узкие тропы, старый дуб, река, заброшенная избушка, тропа егеря с ловушками.',
      backgroundUrl: 'https://picsum.photos/seed/forest/1280/720',
      musicUrl: 'https://example.com/audio/forest.mp3',
      layout: {
        points: [
          { name: 'Главная тропа', details: ['ведёт к бабушке', 'по обочинам цветы'] },
          { name: 'Олений путь', details: ['следы оленей', 'много грибов, часть ядовитые'] },
          { name: 'Волчья тропа', details: ['следы лап и кровь', 'логово с костями'] },
          { name: 'Река', details: ['быстрое течение', 'ржавая стрела на камне'] },
          { name: 'Заброшенная избушка', details: ['мшистая крыша', 'ящик сухарей (+2 HP)'] },
          { name: 'Тропа егеря', details: ['верёвочные петли', 'нож с засохшей кровью'] },
        ],
        npcs: [
          { name: 'Охотник Бернард', item: 'снотворная стрела', trait: 'грубоват, честный' },
          { name: 'Волк', item: '—', trait: 'быстрый, сильный укус' },
          { name: 'Белка Лея', item: 'орех (отвлекает)', trait: 'болтушка' },
          { name: 'Егерь Франц', item: 'карта леса', trait: 'подозрительный' },
          { name: 'Отшельник Мартин', item: 'кристалл', trait: 'странный, ворчливый' },
          { name: 'Травница Эльза', item: 'лечебный бальзам', trait: 'хитрая' },
        ],
        items: ['Ржавая стрела (часть арбалета)', 'Ящик сухарей (+2 HP)', 'Карта леса'],
      },
    },
    {
      order: 3,
      title: 'Деревня бабушки',
      description:
        'Тихая деревня у опушки. Жители насторожены. Изба бабушки, площадь с фонтаном, амбар, дворы.',
      backgroundUrl: 'https://picsum.photos/seed/granny/1280/720',
      musicUrl: 'https://example.com/audio/granny.mp3',
      layout: {
        points: [
          { name: 'Изба бабушки', details: ['пёстрое одеяло', 'сундук с письмами (ключ у Филиции)'] },
          { name: 'Площадь', details: ['маленький фонтан', 'телега у амбара'] },
          { name: 'Амбар', details: ['люк в подвал', 'карта потайного хода'] },
          { name: 'Двор ворчуна', details: ['крыша в трещинах', 'нож на пне'] },
          { name: 'Дом кузины Джесики', details: ['белая кошка', 'коварная хозяйка'] },
        ],
        npcs: [
          { name: 'Старый ворчун Генри', item: '—', trait: 'ворчливый' },
          { name: 'Кузина Джесика', item: '—', trait: 'коварная, связана с волком' },
          { name: 'Кот Мурлыка', item: 'указывает тайный склад', trait: 'ленивый, но полезный' },
          { name: 'Дровосек Роберт', item: '—', trait: 'добродушный' },
          { name: 'Соседка Филиция', item: 'ключ от сундука', trait: 'заботливая, хитрая' },
        ],
        items: ['Ключ от сундука', 'Письма о заговоре'],
      },
    },
  ];

  const created = [];
  for (const loc of data) {
    created.push(
      await prisma.location.create({
        data: {
          gameId,
          order: loc.order,
          title: loc.title,
          description: loc.description,
          backgroundUrl: loc.backgroundUrl,
          layout: loc.layout,
          musicUrl: loc.musicUrl,
        },
      })
    );
  }
  return created;
}

async function seedCharacters(gameId) {
  const existing = await prisma.character.findMany({ where: { gameId } });
  if (existing.length > 0) return existing;

  const playable = [
    {
      name: 'Красная Шапочка',
      race: 'Человек',
      gender: 'Женский',
      avatarUrl: 'https://picsum.photos/seed/redhood_char/200/200',
      description:
        '12 лет. Зелёные глаза, красный плащ. Навыки: отражение ударов (D20), доверие людей (+2 харизма), быстрая походка.',
      role: 'Игровой персонаж',
      persona: 'Добрая, смелая',
      origin: 'Деревня',
      rating: 5,
      isPlayable: true,
    },
    {
      name: 'Жульен',
      race: 'Собака (овчарка)',
      gender: 'Мужской',
      avatarUrl: 'https://picsum.photos/seed/julien/200/200',
      description:
        '6 лет. Следопыт (ищет тайники), укус (урон D8), преданность (принимает удары).',
      role: 'Игровой персонаж',
      persona: 'Преданный, отважный',
      origin: 'Деревня',
      rating: 5,
      isPlayable: true,
    },
    {
      name: 'Люси',
      race: 'Мышь',
      gender: 'Женский',
      avatarUrl: 'https://picsum.photos/seed/lucy/200/200',
      description:
        '2 года. Проникновение (щели), подслушивание (тайные разговоры), отвлечение (сбивает врагов).',
      role: 'Игровой персонаж',
      persona: 'Шустрая, наблюдательная',
      origin: 'Капюшон',
      rating: 5,
      isPlayable: true,
    },
  ];

  const npcs = [
    { name: 'Кузнец Хьюго', race: 'Человек', gender: 'Мужской', avatarUrl: 'https://picsum.photos/seed/hugo/200/200', description: 'Знает о тайной тропе.', role: 'NPC', persona: 'Прямолинейный', origin: 'Деревня', isPlayable: false },
    { name: 'Доярка Агата', race: 'Человек', gender: 'Женский', avatarUrl: 'https://picsum.photos/seed/agata/200/200', description: 'Бутыль молока (лечит).', role: 'NPC', persona: 'Добрая, трусливая', origin: 'Деревня', isPlayable: false },
    { name: 'Пьяница Джордж', race: 'Человек', gender: 'Мужской', avatarUrl: 'https://picsum.photos/seed/george/200/200', description: 'Хлеб — приманка.', role: 'NPC', persona: 'Жадный', origin: 'Деревня', isPlayable: false },
    { name: 'Охотник Бернард', race: 'Человек', gender: 'Мужской', avatarUrl: 'https://picsum.photos/seed/bernard/200/200', description: 'Снотворная стрела.', role: 'NPC', persona: 'Грубоват, честный', origin: 'Лес', isPlayable: false },
    { name: 'Волк', race: 'Зверь', gender: 'Мужской', avatarUrl: 'https://picsum.photos/seed/wolf/200/200', description: 'Быстрый, сильный укус.', role: 'NPC', persona: 'Хищник', origin: 'Лес', isPlayable: false },
    { name: 'Кузина Джесика', race: 'Человек', gender: 'Женский', avatarUrl: 'https://picsum.photos/seed/jessica/200/200', description: 'Коварная, связана с волком.', role: 'NPC', persona: 'Коварная', origin: 'Деревня бабушки', isPlayable: false },
    { name: 'Кот Мурлыка', race: 'Кот', gender: 'Мужской', avatarUrl: 'https://picsum.photos/seed/cat/200/200', description: 'Видит тайные вещи.', role: 'NPC', persona: 'Ленивый, полезный', origin: 'Деревня бабушки', isPlayable: false },
  ];

  const created = [];
  for (const ch of [...playable, ...npcs]) {
    created.push(
      await prisma.character.create({
        data: {
          gameId,
          name: ch.name,
          gender: ch.gender || null,
          race: ch.race || null,
          avatarUrl: ch.avatarUrl,
          description: ch.description || null,
          rating: ch.rating || 5,
          role: ch.role || null,
          voiceId: ch.voiceId || null,
          persona: ch.persona || null,
          origin: ch.origin || null,
          isPlayable: Boolean(ch.isPlayable),
        },
      })
    );
  }
  return created;
}

async function main() {
  const game = await upsertGame();
  await seedLocations(game.id);
  await seedCharacters(game.id);
  console.log('Seeded game Red Hood with id:', game.id);
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });









