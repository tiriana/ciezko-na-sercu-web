const MONTHS_GENITIVE = [
  'stycznia',
  'lutego',
  'marca',
  'kwietnia',
  'maja',
  'czerwca',
  'lipca',
  'sierpnia',
  'września',
  'października',
  'listopada',
  'grudnia',
];

const MONTHS_NOMINATIVE = [
  'Styczeń',
  'Luty',
  'Marzec',
  'Kwiecień',
  'Maj',
  'Czerwiec',
  'Lipiec',
  'Sierpień',
  'Wrzesień',
  'Październik',
  'Listopad',
  'Grudzień',
];

const WEEKDAYS = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];

const parts = (iso: string) => {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day, date: new Date(Date.UTC(year, month - 1, day)) };
};

export const formatDate = (iso: string) => {
  const { year, month, day } = parts(iso);
  return `${day} ${MONTHS_GENITIVE[month - 1]} ${year}`;
};

export const formatWeekday = (iso: string) => WEEKDAYS[parts(iso).date.getUTCDay()];

export const formatDay = (iso: string) => {
  const { year, month, day } = parts(iso);
  return `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${year}`;
};

export const monthKey = (iso: string) => iso.slice(0, 7);

export const monthLabel = (iso: string) => {
  const { year, month } = parts(iso);
  return `${MONTHS_NOMINATIVE[month - 1]} ${year}`;
};

export const formatClock = (seconds: number) => {  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
};

export const pluralTracks = (count: number) => {
  if (count === 1) return '1 utwór';
  if (count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 10 || count % 100 >= 20)) {
    return `${count} utwory`;
  }
  return `${count} utworów`;
};

export const formatEpisodeTitle = (title: string) =>
  title.replace(/godz\.\s*(\d{2})(\d{2})\b/, 'godz. $1:$2');
