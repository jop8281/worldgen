/**
 * Writes eval/inputs/books.csv (200 rows) and eval/inputs/loans.csv (300 rows), the input of prod/worlds/gen-library-loans.
 * Seeded, so every run writes the same bytes. Loans reference books by isbn, loans still open at AS_OF never
 * exceed copies per isbn (past loans are not checked against each other), due_at is borrowed_at plus 21 days,
 * and fine_cents is 25 cents per started day past due_at, counted to returned_at or to AS_OF for an open loan.
 * Usage: npx tsx scripts/gen-library-csv.ts [outDir], where outDir already exists.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../../eval/inputs'));
const AS_OF = Date.parse('2026-10-01T09:00:00Z');
const DAY = 86_400_000;
const LOAN_DAYS = 21;
const FINE_CENTS_PER_DAY = 25;

let seed = 0x5eed_b00c;
const rand = (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};
const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

const GENRES = ['fiction', 'mystery', 'science-fiction', 'fantasy', 'history', 'biography', 'science', 'children', 'poetry', 'travel'] as const;
const BRANCHES = ['central', 'riverside', 'northgate', 'eastfield'] as const;
const FIRST = ['Ada', 'Bram', 'Clara', 'Desmond', 'Elena', 'Farid', 'Grace', 'Hiro', 'Imani', 'Jonas', 'Keiko', 'Luis', 'Maren', 'Nadia', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Soren', 'Tomas', 'Uma', 'Viktor', 'Wen', 'Yara'];
const LAST = ['Abara', 'Bellweather', 'Castellanos', 'Dunmore', 'Eriksen', 'Fairchild', 'Goldberg', 'Haddad', 'Ishikawa', 'Jovanovic', 'Kowalski', 'Lindqvist', 'Mbeki', 'Novak', "O'Hara", 'Petrov', 'Quiroga', 'Rahman', 'Sato', 'Thornbury'];
const ADJ = ['Silent', 'Hidden', 'Last', 'Burning', 'Glass', 'Northern', 'Quiet', 'Broken', 'Golden', 'Forgotten', 'Distant', 'Hollow', 'Salt', 'Paper', 'Iron', 'Winter'];
const NOUN = ['River', 'Garden', 'Archive', 'Harbor', 'Orchard', 'Lighthouse', 'Atlas', 'Kingdom', 'Signal', 'Cartographer', 'Tide', 'Library', 'Meridian', 'Compass', 'Engine', 'Season'];
const TAIL = ['', '', '', ', a Novel', ': A History', ', Volume II', ' and Other Stories', ': Notes from the Field'];

const quote = (cell: string): string => (/[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);
const csv = (header: readonly string[], rows: readonly (readonly string[])[]): string =>
  [header, ...rows].map((r) => r.map(quote).join(',')).join('\n') + '\n';
const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

const isbn13 = (n: number): string => {
  const body = `9781${String(100_000_000 + n * 102_953).slice(-8)}`;
  const sum = [...body].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return body + String((10 - (sum % 10)) % 10);
};

type Book = { isbn: string; title: string; author: string; genre: string; copies: number; branch: string };
const books: Book[] = [];
const titles = new Set<string>();
for (let n = 1; books.length < 200; n++) {
  const title = `The ${pick(ADJ)} ${pick(NOUN)}${pick(TAIL)}`;
  if (titles.has(title)) continue;
  titles.add(title);
  books.push({ isbn: isbn13(n), title, author: `${pick(FIRST)} ${pick(LAST)}`, genre: pick(GENRES), copies: int(1, 6), branch: pick(BRANCHES) });
}

const START = Date.parse('2026-06-15T09:00:00Z');
const open = new Map<string, number>();
const loans: string[][] = [];
while (loans.length < 300) {
  const book = pick(books);
  const borrowed = START + int(0, 105) * DAY + int(0, 9) * 3_600_000;
  const due = borrowed + LOAN_DAYS * DAY;
  const r = rand();
  const stale = AS_OF - borrowed > 50 * DAY && rand() < 0.85;
  const returnedDays = r < 0.62 ? int(3, LOAN_DAYS) : r < 0.82 || stale ? int(LOAN_DAYS + 1, LOAN_DAYS + 30) : null;
  let returned = returnedDays === null ? null : borrowed + returnedDays * DAY + int(0, 6) * 3_600_000;
  if (returned !== null && returned > AS_OF) returned = null;
  if (returned === null) {
    if ((open.get(book.isbn) ?? 0) >= book.copies) continue;
    open.set(book.isbn, (open.get(book.isbn) ?? 0) + 1);
  }
  const lateDays = Math.max(0, Math.ceil(((returned ?? AS_OF) - due) / DAY));
  const id = `L${String(loans.length + 1).padStart(5, '0')}`;
  loans.push([id, book.isbn, `M${String(int(1, 120)).padStart(4, '0')}`, iso(borrowed), iso(due), returned === null ? '' : iso(returned), String(lateDays * FINE_CENTS_PER_DAY)]);
}
loans.sort((a, b) => a[3]!.localeCompare(b[3]!));
loans.forEach((l, i) => (l[0] = `L${String(i + 1).padStart(5, '0')}`));

writeFileSync(path.join(OUT, 'books.csv'), csv(['isbn', 'title', 'author', 'genre', 'copies', 'branch'], books.map((b) => [b.isbn, b.title, b.author, b.genre, String(b.copies), b.branch])));
writeFileSync(path.join(OUT, 'loans.csv'), csv(['loan_id', 'isbn', 'member_id', 'borrowed_at', 'due_at', 'returned_at', 'fine_cents'], loans));
console.log(`wrote ${books.length} books and ${loans.length} loans to ${OUT}`);
