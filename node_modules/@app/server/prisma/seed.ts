import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const exists = await prisma.game.findFirst();
  if (exists) return;

  const game = await prisma.game.create({
    data: {
      title: 'Название игры',
      description: 'Описание игры...',
      rating: 5,
      tags: ['Фэнтези', 'Командные'],
      author: 'Имя автора',
      coverUrl: 'https://picsum.photos/seed/cover/800/360',
      rules: 'Правила игры...',
      gallery: ['https://picsum.photos/seed/thumb_0/200/120'],
    },
  });
  await prisma.edition.createMany({
    data: [
      { name: 'Эконом издание', description: 'Базовый комплект', price: 990, gameId: game.id },
      { name: 'Стандартное издание', description: 'Оптимальный выбор', price: 1990, gameId: game.id },
      { name: 'Коллекционное издание', description: 'Максимум контента', price: 3990, gameId: game.id },
    ],
  });
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });


