"""外部プロセス境界とUSI順序のテスト用。探索はしない。"""
import sys

for command in sys.stdin:
    command = command.strip()
    if command == 'usi':
        print('id name INTERNAL_NAME_NOT_FOR_API')
        print('usiok', flush=True)
    elif command == 'isready':
        print('readyok', flush=True)
    elif command.startswith('go '):
        print('info string INTERNAL_NAME_NOT_FOR_API')
        print('info depth 4 multipv 1 score cp 123 nodes 50 pv 7g7f 3c3d')
        print('bestmove 7g7f', flush=True)
    elif command == 'quit':
        break
