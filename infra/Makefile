deploy:
	docker --host 'ssh://ubuntu@binance' compose -p gridbot -f docker-compose.yml --env-file .env up -d --build
recreate:
	docker --host 'ssh://ubuntu@binance' compose -p gridbot -f docker-compose.yml --env-file .env up -d --force-recreate
logs:
	docker --host 'ssh://ubuntu@binance' compose -p gridbot -f docker-compose.yml --env-file .env logs --follow
ps:
	docker --host 'ssh://ubuntu@binance' compose -p gridbot -f docker-compose.yml --env-file .env ps
top:
	docker --host 'ssh://ubuntu@binance' compose -p gridbot -f docker-compose.yml --env-file .env top
down:
	docker --host 'ssh://ubuntu@binance' compose -p gridbot -f docker-compose.yml --env-file .env down
stop:
	docker --host 'ssh://ubuntu@binance' compose -p gridbot -f docker-compose.yml --env-file .env down