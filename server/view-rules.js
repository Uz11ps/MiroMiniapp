// Скрипт для просмотра правил игры из базы данных
import 'dotenv/config';
import { getPrisma } from './dist/prisma.js';

const prisma = getPrisma();

async function viewRules() {
  try {
    // Получаем список всех игр
    const games = await prisma.game.findMany({
      select: {
        id: true,
        title: true,
        worldRules: true,
        gameplayRules: true,
        worldRulesFull: true,
        gameplayRulesFull: true,
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    if (games.length === 0) {
      console.log('❌ Игры не найдены в базе данных');
      return;
    }

    console.log(`\n📚 Найдено игр: ${games.length}\n`);
    console.log('═'.repeat(80));

    // Выводим правила для каждой игры
    for (const game of games) {
      console.log(`\n🎮 Игра: ${game.title}`);
      console.log(`   ID: ${game.id}`);
      console.log('─'.repeat(80));

      // Краткие правила мира
      if (game.worldRules) {
        console.log('\n📖 Правила мира (краткие, для UI):');
        console.log(`   ${game.worldRules}`);
        console.log(`   Длина: ${game.worldRules.length} символов`);
      } else {
        console.log('\n📖 Правила мира (краткие): не указаны');
      }

      // Полные правила мира
      if (game.worldRulesFull) {
        console.log('\n📖 Правила мира (полные, для ИИ):');
        const preview = game.worldRulesFull.length > 500 
          ? game.worldRulesFull.slice(0, 500) + '...' 
          : game.worldRulesFull;
        console.log(`   ${preview}`);
        console.log(`   Длина: ${game.worldRulesFull.length} символов`);
      } else {
        console.log('\n📖 Правила мира (полные): не указаны');
      }

      // Краткие правила процесса
      if (game.gameplayRules) {
        console.log('\n⚙️  Правила игрового процесса (краткие, для UI):');
        console.log(`   ${game.gameplayRules}`);
        console.log(`   Длина: ${game.gameplayRules.length} символов`);
      } else {
        console.log('\n⚙️  Правила игрового процесса (краткие): не указаны');
      }

      // Полные правила процесса
      if (game.gameplayRulesFull) {
        console.log('\n⚙️  Правила игрового процесса (полные, для ИИ):');
        const preview = game.gameplayRulesFull.length > 500 
          ? game.gameplayRulesFull.slice(0, 500) + '...' 
          : game.gameplayRulesFull;
        console.log(`   ${preview}`);
        console.log(`   Длина: ${game.gameplayRulesFull.length} символов`);
      } else {
        console.log('\n⚙️  Правила игрового процесса (полные): не указаны');
      }

      console.log('\n' + '═'.repeat(80));
    }

    // Статистика
    console.log('\n📊 Статистика:');
    const withWorldRules = games.filter(g => g.worldRules || g.worldRulesFull).length;
    const withGameplayRules = games.filter(g => g.gameplayRules || g.gameplayRulesFull).length;
    const withFullRules = games.filter(g => g.worldRulesFull || g.gameplayRulesFull).length;
    
    console.log(`   Игр с правилами мира: ${withWorldRules}`);
    console.log(`   Игр с правилами процесса: ${withGameplayRules}`);
    console.log(`   Игр с полными правилами: ${withFullRules}`);

  } catch (error) {
    console.error('❌ Ошибка при получении данных:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// Если передан ID игры как аргумент, показываем только эту игру
const gameId = process.argv[2];

if (gameId) {
  // Показываем правила для конкретной игры
  (async () => {
    try {
      const game = await prisma.game.findUnique({
        where: { id: gameId },
        select: {
          id: true,
          title: true,
          worldRules: true,
          gameplayRules: true,
          worldRulesFull: true,
          gameplayRulesFull: true,
        }
      });

      if (!game) {
        console.log(`❌ Игра с ID "${gameId}" не найдена`);
        await prisma.$disconnect();
        return;
      }

      console.log(`\n🎮 Игра: ${game.title}`);
      console.log(`   ID: ${game.id}`);
      console.log('═'.repeat(80));

      if (game.worldRules) {
        console.log('\n📖 Правила мира (краткие):');
        console.log(game.worldRules);
      }

      if (game.worldRulesFull) {
        console.log('\n📖 Правила мира (полные):');
        console.log(game.worldRulesFull);
      }

      if (game.gameplayRules) {
        console.log('\n⚙️  Правила игрового процесса (краткие):');
        console.log(game.gameplayRules);
      }

      if (game.gameplayRulesFull) {
        console.log('\n⚙️  Правила игрового процесса (полные):');
        console.log(game.gameplayRulesFull);
      }

      await prisma.$disconnect();
    } catch (error) {
      console.error('❌ Ошибка:', error);
      await prisma.$disconnect();
    }
  })();
} else {
  // Показываем все игры
  viewRules();
}

