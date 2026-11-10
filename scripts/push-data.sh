#!/usr/bin/env bash
# Commituje podane ścieżki i wypycha je na main, dopasowując się do zdalnego.
# Na main pisze równolegle kilka workflowów (wydania, transkrypcja, profil głosu,
# katalog) i zwykłe `git push` przy wyścigu odrzuca commit — a wraz z nim przepada
# kilkugodzinna praca runnera. Dlatego push idzie w pętli z rebase i odczekaniem.
#
# Użycie: scripts/push-data.sh "komunikat commita" <ścieżka> [<ścieżka>…]
# Ustawia `changed` w $GITHUB_OUTPUT (gdy zmienna istnieje), żeby workflow wiedział,
# czy jest co wdrażać. Kody wyjścia: 0 = wypchnięte albo brak zmian, 1 = porażka.
set -euo pipefail

message="${1:-dane}"
shift
if [ "$#" -eq 0 ]; then
  echo "push-data.sh: podaj przynajmniej jedną ścieżkę" >&2
  exit 2
fi

output="${GITHUB_OUTPUT:-/dev/null}"
git config user.name 'github-actions[bot]'
git config user.email 'github-actions[bot]@users.noreply.github.com'

git add -- "$@"
if git diff --cached --quiet; then
  echo "Brak zmian."
  echo "changed=false" >>"$output"
  exit 0
fi
git commit -m "$message"
echo "changed=true" >>"$output"

attempt=1
while [ "$attempt" -le 5 ]; do
  # Autostash, bo po nieudanym pushu zdalny bywa nowszy; konflikt przerywamy,
  # żeby kolejna próba nie zaczynała się w połowie rebase'a.
  if ! git pull --rebase --autostash --quiet origin main; then
    git rebase --abort 2>/dev/null || true
    echo "próba $attempt: nie udało się dopasować do origin/main" >&2
    sleep $((attempt * 5))
    attempt=$((attempt + 1))
    continue
  fi
  if git push --quiet; then
    echo "wypchnięte (próba $attempt)"
    exit 0
  fi
  echo "próba $attempt: push odrzucony, próbuję ponownie" >&2
  sleep $((attempt * 5))
  attempt=$((attempt + 1))
done

echo "push-data.sh: nie udało się wypchnąć zmian po 5 próbach" >&2
exit 1
