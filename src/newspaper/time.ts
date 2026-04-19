const CHICAGO_DATE_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

function getParts(date: Date): Record<string, string> {
  const parts = CHICAGO_DATE_PARTS.formatToParts(date);
  const values: Record<string, string> = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }

  return values;
}

export function getChicagoHour(date: Date): number {
  return Number(getParts(date).hour);
}

export function getChicagoDateString(date: Date): string {
  const parts = getParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}
