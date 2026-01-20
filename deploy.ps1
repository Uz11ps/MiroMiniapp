Write-Host 'Starting deployment...'
docker compose pull
docker compose up -d --build
Write-Host 'Waiting for database to be ready...'
Start-Sleep -Seconds 5
Write-Host 'Running database migrations...'
docker compose exec -T server npx prisma db push --accept-data-loss
Write-Host 'Seeding database...'
docker compose exec -T server npm run db:seed
Write-Host 'Deployment finished!'
