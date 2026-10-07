/**
 * Writes eval/inputs/live/gym-bookings.csv, the CSV input of the live segment in research/demo-runbook.md.
 * One denormalized file: each row is a booking and repeats its class's columns, so WorldGen has to split classes
 * from bookings. Seeded, so every run writes the same bytes. In booked_at order, the first `capacity` bookings of a
 * class that were not cancelled hold seats and the rest are waitlisted. A class that started before AS_OF has no
 * booked or waitlisted rows: a seat became attended or no_show, and the waitlist was cancelled at the start.
 * Usage: bun scripts/gen-gym-csv.ts [outDir], where outDir already exists.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../../eval/inputs/live'));
const AS_OF = Date.parse('2026-10-07T06:00:00Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;

let seed = 0x6e_c1a55;
const rand = (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};
const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

const CLASSES = [
  ['Morning Flow Yoga', 60],
  ['Spin 45', 45],
  ['Kettlebell Strength', 50],
  ['Pilates Core', 55],
  ['HIIT Circuit', 40],
  ['Boxing Basics', 60],
] as const;
const INSTRUCTORS = ['Ana Duarte', 'Ben Okafor', 'Chloe Varga', 'Dev Malhotra', 'Erin Walsh'] as const;
const STUDIOS = ['studio-a', 'studio-b', 'cycle-room'] as const;
const SLOTS = [6, 7, 12, 17, 18, 19] as const;

const quote = (cell: string): string => (/[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);
const csv = (header: readonly string[], rows: readonly (readonly string[])[]): string =>
  [header, ...rows].map((r) => r.map(quote).join(',')).join('\n') + '\n';
const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

type Row = { classId: string; name: string; instructor: string; studio: string; starts: number; minutes: number; capacity: number; member: string; booked: number; status: string };
const rows: Row[] = [];
const FIRST_DAY = AS_OF - 6 * DAY - 6 * HOUR;
for (let n = 1; n <= 16; n++) {
  const [name, minutes] = pick(CLASSES);
  const studio = name.startsWith('Spin') ? 'cycle-room' : pick(STUDIOS.filter((s) => s !== 'cycle-room'));
  const starts = FIRST_DAY + int(0, 12) * DAY + pick(SLOTS) * HOUR;
  const capacity = studio === 'cycle-room' ? 12 : pick([8, 10, 14]);
  const classId = `C${String(n).padStart(3, '0')}`;
  const instructor = pick(INSTRUCTORS);
  const wanted = Math.round(capacity * (0.5 + rand() * 0.8));
  const members = new Set<string>();
  while (members.size < wanted) members.add(`M${String(int(1, 60)).padStart(3, '0')}`);
  const latest = Math.min(starts - 2 * HOUR, AS_OF - HOUR);
  const booked = [...members].map((member) => ({ member, at: latest - int(0, 5 * 24 * 60) * 60_000 })).sort((a, b) => a.at - b.at);
  let seated = 0;
  for (const b of booked) {
    let status: string;
    if (rand() < 0.12) status = 'cancelled';
    else if (seated < capacity) {
      seated++;
      status = starts > AS_OF ? 'booked' : rand() < 0.86 ? 'attended' : 'no_show';
    } else status = starts > AS_OF ? 'waitlisted' : 'cancelled';
    rows.push({ classId, name, instructor, studio, starts, minutes, capacity, member: b.member, booked: b.at, status });
  }
}
rows.sort((a, b) => a.booked - b.booked || a.classId.localeCompare(b.classId));

const header = ['booking_id', 'class_id', 'class_name', 'instructor', 'studio', 'starts_at', 'duration_min', 'capacity', 'member_id', 'booked_at', 'status'];
writeFileSync(
  path.join(OUT, 'gym-bookings.csv'),
  csv(header, rows.map((r, i) => [`B${String(i + 1).padStart(4, '0')}`, r.classId, r.name, r.instructor, r.studio, iso(r.starts), String(r.minutes), String(r.capacity), r.member, iso(r.booked), r.status])),
);
console.log(`wrote ${rows.length} bookings in ${new Set(rows.map((r) => r.classId)).size} classes to ${OUT}`);
