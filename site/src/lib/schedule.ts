/**
 * Szacunek kolejki opracowań. Dokładność jest rzędu dnia, nie godziny: czas jednego
 * odcinka zależy od długości mowy i od tego, ile okien whisper przepisuje.
 *
 * Pomiar z 2026-11-04 (odcinek 1:54:32, mowa 27:05): transkrypcja 15 min, Shazam 1,5 min,
 * LLM 2 min, scalenie i publikacja kilkanaście sekund — razem ~18,5 min.
 */
export const MINUTES_PER_EPISODE = 18.5;

/** Okno nocne 21:00–09:00. */
export const NIGHT_MINUTES = 12 * 60;

export interface ScheduleEstimate {
  remaining: number;
  perNight: number;
  nights: number;
  finishDate: string | null;
}

export function estimateSchedule(done: number, total: number, now = new Date()): ScheduleEstimate {
  const remaining = Math.max(0, total - done);
  const perNight = Math.max(1, Math.floor(NIGHT_MINUTES / MINUTES_PER_EPISODE));
  const nights = remaining === 0 ? 0 : Math.ceil(remaining / perNight);
  if (nights === 0) return { remaining, perNight, nights, finishDate: null };

  const finish = new Date(now);
  finish.setDate(finish.getDate() + nights);
  return { remaining, perNight, nights, finishDate: finish.toISOString().slice(0, 10) };
}

export interface PlannedEntry {
  slug: string;
  date: string;
  enriched: boolean;
}

/**
 * Przydziela każdej nieopracowanej audycji noc, w której ma szansę powstać.
 * Kolejność jest ta sama co w kolejce taggera: od najnowszych. Data to ranek po nocy,
 * bo dopiero wtedy odcinek jest gotowy — dokładność rzędu dnia, nie godziny.
 */
export function planQueue(entries: PlannedEntry[], now = new Date()): Map<string, string> {
  const perNight = Math.max(1, Math.floor(NIGHT_MINUTES / MINUTES_PER_EPISODE));
  const pending = entries
    .filter((entry) => !entry.enriched)
    .sort((a, b) => b.date.localeCompare(a.date));

  const plan = new Map<string, string>();
  pending.forEach((entry, index) => {
    const nights = Math.floor(index / perNight) + 1;
    const finish = new Date(now);
    finish.setDate(finish.getDate() + nights);
    plan.set(entry.slug, finish.toISOString().slice(0, 10));
  });
  return plan;
}
