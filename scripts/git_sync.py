#!/usr/bin/env python3
"""Sincronizzazione Git automatica di Jarvis (pull + push), nel rispetto delle regole di AGENTS.md.

Uso:
  python scripts/git_sync.py                      pull e push del branch attuale
  python scripts/git_sync.py -m "messaggio"       salva anche le modifiche non salvate (commit) e poi sincronizza
  python scripts/git_sync.py --branch nome        se sei su main con modifiche, crea prima il branch "nome"
  python scripts/git_sync.py --watch 10           ripete la sincronizzazione ogni 10 minuti
  python scripts/git_sync.py --watch 10 --auto-commit   ... e salva da solo le modifiche
  python scripts/git_sync.py --pull-only          solo aggiornamento, niente push

Cosa fa, in ordine:
  1. git fetch.
  2. Su main: solo pull fast-forward. Mai commit né push diretti su main (si pubblica con le PR).
  3. Su un branch: se ci sono modifiche e un messaggio (o --auto-commit), controlla le regole
     (niente credenziali, versione di web/sw.js e dell'app aumentate, npm test verde) e fa il commit.
  4. Porta dentro le novità di origin/main con un merge (niente rebase: mai push forzati).
  5. Push del branch e, se c'è il comando gh, apre la Pull Request verso main.
"""

import argparse
import re
import shutil
import subprocess
import sys
import time

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

MAIN = 'main'
REMOTE = 'origin'
# File che non devono mai finire nel repo (regola 6).
SECRET_FILES = re.compile(r'(\.jks|\.keystore|\.p12|\.pem|\.key|local\.properties|(^|/)\.env(\..*)?|\.dev\.vars)$', re.I)
SECRET_TEXT = re.compile(r'(?<![A-Za-z0-9_])(AIza[0-9A-Za-z_\-]{30,}|ghp_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{30,}|gsk_[0-9A-Za-z]{30,}|nvapi-[0-9A-Za-z_\-]{30,}|sk-(or-|ant-)?[0-9A-Za-z_\-]{30,})|-----BEGIN [A-Z ]*PRIVATE KEY-----')


class SyncError(Exception):
    pass


def git(*args, check=True):
    r = subprocess.run(['git', *args], capture_output=True, text=True, encoding='utf-8', errors='replace')
    if check and r.returncode != 0:
        raise SyncError(f"git {' '.join(args)} non riuscito:\n{(r.stderr or r.stdout).strip()}")
    return r.stdout.strip()


def say(msg):
    print(f'[sync] {msg}', flush=True)


def current_branch():
    b = git('rev-parse', '--abbrev-ref', 'HEAD')
    if b == 'HEAD':
        raise SyncError('Sei in "detached HEAD": passa a un branch prima di sincronizzare.')
    return b


def dirty():
    return bool(git('status', '--porcelain'))


def changed_vs_main():
    """File cambiati nel branch (commit e modifiche locali) rispetto a origin/main."""
    base = git('merge-base', 'HEAD', f'{REMOTE}/{MAIN}', check=False) or f'{REMOTE}/{MAIN}'
    files = set(git('diff', '--name-only', base).splitlines())
    files |= set(git('ls-files', '--others', '--exclude-standard').splitlines())
    return {f.replace('\\', '/') for f in files if f}


def check_rules(files):
    """Regole di AGENTS.md controllabili in automatico. Solleva SyncError se non rispettate."""
    problems = []
    for f in sorted(files):
        if SECRET_FILES.search(f):
            problems.append(f'file con credenziali o chiavi: {f} (regola 6)')
    added = git('diff', 'HEAD', '--unified=0', check=False)
    for line in added.splitlines():
        if line.startswith('+') and not line.startswith('+++') and SECRET_TEXT.search(line):
            problems.append(f'sembra esserci una chiave o un token nel codice: {line[:80]}... (regola 6)')
    for f in sorted(git('ls-files', '--others', '--exclude-standard').splitlines()):
        try:
            with open(f, encoding='utf-8', errors='ignore') as fh:
                if SECRET_TEXT.search(fh.read(2_000_000)):
                    problems.append(f'sembra esserci una chiave o un token in {f} (regola 6)')
        except OSError:
            pass
    web = [f for f in files if f.startswith('web/') and f != 'web/sw.js']
    if web and 'web/sw.js' not in files:
        problems.append('hai cambiato web/ ma non la versione della cache in web/sw.js (regola 5)')
    app = [f for f in files if f.startswith('app/') and f != 'app/build.gradle.kts']
    if app and 'app/build.gradle.kts' not in files:
        problems.append('hai cambiato app/ ma non versionCode/versionName in app/build.gradle.kts (regola 5)')
    if problems:
        raise SyncError('Sincronizzazione fermata:\n  - ' + '\n  - '.join(problems))


def run_tests(skip):
    if skip:
        say('test saltati (--no-test): li farà comunque la CI sulla Pull Request.')
        return
    npm = shutil.which('npm')
    if not npm:
        say('npm non trovato su questo computer: i test li farà la CI sulla Pull Request.')
        return
    say('eseguo npm test...')
    r = subprocess.run([npm, 'test'], capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode != 0:
        tail = '\n'.join((r.stdout + r.stderr).strip().splitlines()[-25:])
        raise SyncError(f'npm test non passa (regola 4): niente commit né push.\n{tail}')
    say('test verdi.')


def auto_message(files):
    names = sorted(files)
    short = ', '.join(names[:4]) + (f' e altri {len(names) - 4}' if len(names) > 4 else '')
    return f'Aggiornamento automatico: {short}'


def open_pr(branch):
    gh = shutil.which('gh')
    url = git('remote', 'get-url', REMOTE).removesuffix('.git')
    if not gh:
        say(f'apri la Pull Request qui: {url}/compare/{MAIN}...{branch}?expand=1')
        return
    existing = subprocess.run([gh, 'pr', 'view', branch, '--json', 'url', '-q', '.url'], capture_output=True, text=True)
    if existing.returncode == 0 and existing.stdout.strip():
        say(f'Pull Request già aperta: {existing.stdout.strip()}')
        return
    r = subprocess.run([gh, 'pr', 'create', '--base', MAIN, '--head', branch, '--fill'], capture_output=True, text=True)
    if r.returncode == 0:
        say(f'Pull Request aperta: {r.stdout.strip()}')
    else:
        say(f'non sono riuscito ad aprire la PR con gh ({r.stderr.strip()[:200]}). Aprila qui: {url}/compare/{MAIN}...{branch}?expand=1')


def sync(args):
    git('rev-parse', '--git-dir')
    say('scarico le novità (fetch)...')
    git('fetch', REMOTE, '--prune')
    branch = current_branch()

    if branch == MAIN:
        if dirty() and args.branch:
            git('switch', '-c', args.branch)
            branch = args.branch
            say(f'creato il branch {branch}: su main non si lavora direttamente (regola 3).')
        elif dirty():
            raise SyncError('Sei su main con modifiche non salvate. Su main non si fanno commit (regola 3): '
                            'rilancia con --branch nome-branch per spostarle su un branch nuovo.')
        else:
            git('merge', '--ff-only', f'{REMOTE}/{MAIN}')
            say('main aggiornato. Su main non si fa push: si pubblica unendo le Pull Request.')
            return

    if dirty():
        message = args.message or (auto_message(changed_vs_main()) if args.auto_commit else None)
        if not message:
            say('ci sono modifiche non salvate: le lascio come sono (usa -m "messaggio" o --auto-commit per salvarle).')
        elif not args.pull_only:
            check_rules(changed_vs_main())
            run_tests(args.no_test)
            git('add', '-A')
            git('commit', '-m', message)
            say(f'commit: {message}')

    # Novità da main dentro il branch: merge, così il push non va mai forzato.
    if git('rev-list', '--count', f'HEAD..{REMOTE}/{MAIN}') != '0':
        if dirty():
            say('main ha novità, ma con modifiche non salvate non le unisco: salvale prima.')
        else:
            r = subprocess.run(['git', 'merge', '--no-edit', f'{REMOTE}/{MAIN}'], capture_output=True, text=True)
            if r.returncode != 0:
                subprocess.run(['git', 'merge', '--abort'], capture_output=True)
                raise SyncError('Conflitto unendo main nel branch: unione annullata, niente è andato perso. '
                                'Va risolto a mano (git merge origin/main).')
            say('unite le novità di main nel branch.')

    # Novità dello stesso branch fatte altrove (es. da un altro computer o assistente).
    upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}', check=False)
    if upstream and not dirty() and git('rev-list', '--count', f'HEAD..{upstream}') != '0':
        git('merge', '--ff-only', upstream) if git('rev-list', '--count', f'{upstream}..HEAD') == '0' else git('merge', '--no-edit', upstream)
        say(f'scaricate le novità di {upstream}.')

    if args.pull_only:
        say('solo pull: fatto.')
        return
    ahead = git('rev-list', '--count', f'{upstream}..HEAD') if upstream else '1'
    if ahead == '0':
        say('niente di nuovo da inviare.')
        return
    git('push', '-u', REMOTE, branch)
    say(f'push di {branch} fatto. La CI controlla la Pull Request; unire su main pubblica tutto.')
    if not args.no_pr:
        open_pr(branch)


def main():
    p = argparse.ArgumentParser(description='Pull e push automatici di Jarvis, nel rispetto di AGENTS.md.')
    p.add_argument('-m', '--message', help='messaggio di commit (in italiano) per le modifiche non salvate')
    p.add_argument('--branch', help='se sei su main con modifiche, crea questo branch e lavora lì')
    p.add_argument('--auto-commit', action='store_true', help='salva da solo le modifiche con un messaggio automatico')
    p.add_argument('--pull-only', action='store_true', help='solo aggiornamento, niente commit né push')
    p.add_argument('--no-test', action='store_true', help='non eseguire npm test prima del commit (la CI li esegue comunque)')
    p.add_argument('--no-pr', action='store_true', help='non aprire la Pull Request')
    p.add_argument('--watch', type=float, metavar='MINUTI', help='ripeti la sincronizzazione ogni MINUTI')
    args = p.parse_args()

    while True:
        try:
            sync(args)
        except SyncError as e:
            say(str(e))
            if not args.watch:
                sys.exit(1)
        if not args.watch:
            return
        say(f'prossima sincronizzazione tra {args.watch:g} minuti (Ctrl+C per fermare).')
        try:
            time.sleep(args.watch * 60)
        except KeyboardInterrupt:
            say('fermato.')
            return


if __name__ == '__main__':
    main()
