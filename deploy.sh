#!/bin/bash
echo 'Starting deployment...'
docker compose pull
docker compose up -d --build
echo 'Waiting for database to be ready...'
sleep 5
echo 'Running database migrations...'
docker compose exec -T server npx prisma db push --accept-data-loss
echo 'Seeding database...'
docker compose exec -T server npm run db:seed
echo 'Deployment finished!'
