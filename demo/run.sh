#!/bin/bash
set -e
cd "$(dirname "$0")/../sample-app"

echo "$ bareboat new --name hello --port 3001 --target local"
sleep 1
node ../dist/cli.js new --name hello --port 3001 --target local
sleep 1
node ../dist/cli.js env set PORT=3001
sleep 2

echo ""
echo "$ bareboat deploy"
sleep 1
node ../dist/cli.js deploy
sleep 2

echo ""
echo "$ bareboat status"
sleep 1
node ../dist/cli.js status
sleep 2

echo ""
echo "$ curl http://localhost:3001"
sleep 1
curl -s http://localhost:3001
echo ""
sleep 2

echo ""
echo "$ bareboat logs"
sleep 1
node ../dist/cli.js logs
sleep 2

echo ""
echo "$ bareboat destroy"
sleep 1
node ../dist/cli.js destroy
sleep 1
