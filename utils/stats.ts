import { WorkoutSession, WorkoutTemplate } from "../types";

export type StatsRange = "month" | "90d" | "year" | "all";
export const RANGE_LABELS: Record<StatsRange, string> = {
    month: "This month", "90d": "Last 90 days", year: "Last year", all: "All time",
};

export interface SessionPoint {
    date: string;
    e1rm: number;
    volume: number;
    maxLoad: number;
    maxReps: number;
    sets: number;
}

export interface ExerciseSummary {
    name: string;
    muscleGroup: string;
    isBodyweight: boolean;
    /** No load known (bodyweight without configured body weight), so reps drive the metrics. */
    repsBased: boolean;
    sessions: number;
    sets: number;
    reps: number;
    volume: number;
    bestLoad: number;
    bestE1RM: number;
    bestReps: number;
    bestSetVolume: number;
    prDate: string;
    lastDate: string;
    /** % change of the main metric, first vs. last session in range. */
    trend: number | null;
    points: SessionPoint[];
}

export interface WeekBucket {
    label: string;
    workouts: number;
    volume: number;
}

export interface Stats {
    workouts: number;
    sets: number;
    reps: number;
    volume: number;
    avgPerWeek: number;
    currentStreakWeeks: number;
    longestStreakWeeks: number;
    exercises: ExerciseSummary[];
    muscles: { name: string; sets: number }[];
    weeks: WeekBucket[];
}

function fmt(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function todayString(): string {
    return fmt(new Date());
}

export function rangeStart(range: StatsRange): string | null {
    const n = new Date();
    switch (range) {
        case "month": return fmt(new Date(n.getFullYear(), n.getMonth(), 1));
        case "90d": return fmt(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 89));
        case "year": return fmt(new Date(n.getFullYear() - 1, n.getMonth(), n.getDate() + 1));
        default: return null;
    }
}

function e1rm(load: number, reps: number): number {
    if (reps <= 0 || load <= 0) return 0;
    return reps === 1 ? load : load * (1 + reps / 30);
}

/** Monday-based week number since epoch. */
function weekIndex(date: string): number {
    const [y, m, d] = date.split("-").map(Number);
    return Math.floor((Math.floor(Date.UTC(y, m - 1, d) / 86400000) + 3) / 7);
}

function weekLabel(idx: number): string {
    const d = new Date((idx * 7 - 3) * 86400000);
    return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.`;
}

interface Ctx {
    bodyWeight: number;
    bwNames: Set<string>;
    muscle: Map<string, string>;
}

function buildCtx(sessions: WorkoutSession[], templates: WorkoutTemplate[], bodyWeight: number): Ctx {
    const bwNames = new Set<string>();
    const muscle = new Map<string, string>();
    for (const t of templates) {
        for (const ex of t.exercises) {
            if ((ex.equipment ?? "").toLowerCase().replace(/\s/g, "") === "bodyweight") bwNames.add(ex.name);
            const mg = ex.muscleGroup || ex.target || ex.category;
            if (mg && !muscle.has(ex.name)) muscle.set(ex.name, mg);
        }
    }
    // Exercises never logged with any weight count as bodyweight too
    const weighted = new Set<string>();
    const seen = new Set<string>();
    for (const s of sessions) {
        for (const ex of s.exercises) {
            for (const set of ex.sets) {
                if (set.skipped) continue;
                seen.add(ex.name);
                if (set.weight > 0) weighted.add(ex.name);
            }
        }
    }
    for (const n of seen) if (!weighted.has(n)) bwNames.add(n);
    return { bodyWeight, bwNames, muscle };
}

export function computeStats(
    allSessions: Record<string, WorkoutSession>,
    templates: WorkoutTemplate[],
    bodyWeight: number,
    from: string | null,
    today: string
): Stats {
    const all = Object.values(allSessions).sort((a, b) => a.date.localeCompare(b.date));
    const ctx = buildCtx(all, templates, bodyWeight);
    const inRange = all.filter(s => (from === null || s.date >= from) && s.date <= today);

    const exMap = new Map<string, ExerciseSummary>();
    const muscleSets = new Map<string, number>();
    const weekMap = new Map<number, WeekBucket>();
    let totalSets = 0, totalReps = 0, totalVolume = 0;

    for (const s of inRange) {
        const wi = weekIndex(s.date);
        let wb = weekMap.get(wi);
        if (!wb) { wb = { label: weekLabel(wi), workouts: 0, volume: 0 }; weekMap.set(wi, wb); }
        wb.workouts++;

        for (const ex of s.exercises) {
            if (ex.skipped) continue;
            const isBW = ctx.bwNames.has(ex.name);
            let sum = exMap.get(ex.name);
            if (!sum) {
                sum = {
                    name: ex.name, muscleGroup: ctx.muscle.get(ex.name) ?? "other", isBodyweight: isBW,
                    repsBased: false, sessions: 0, sets: 0, reps: 0, volume: 0, bestLoad: 0, bestE1RM: 0,
                    bestReps: 0, bestSetVolume: 0, prDate: "", lastDate: "", trend: null, points: [],
                };
                exMap.set(ex.name, sum);
            }
            const pt: SessionPoint = { date: s.date, e1rm: 0, volume: 0, maxLoad: 0, maxReps: 0, sets: 0 };
            for (const set of ex.sets) {
                if (set.skipped || set.reps <= 0) continue;
                const load = (isBW ? ctx.bodyWeight : 0) + set.weight;
                const vol = load * set.reps;
                pt.sets++;
                pt.volume += vol;
                pt.maxLoad = Math.max(pt.maxLoad, load);
                pt.maxReps = Math.max(pt.maxReps, set.reps);
                pt.e1rm = Math.max(pt.e1rm, e1rm(load, set.reps));
                sum.reps += set.reps;
                sum.bestSetVolume = Math.max(sum.bestSetVolume, vol);
                muscleSets.set(sum.muscleGroup, (muscleSets.get(sum.muscleGroup) ?? 0) + 1);
                wb.volume += vol;
            }
            if (pt.sets === 0) continue;
            sum.sessions++;
            sum.sets += pt.sets;
            sum.volume += pt.volume;
            sum.lastDate = s.date;
            sum.bestLoad = Math.max(sum.bestLoad, pt.maxLoad);
            sum.bestReps = Math.max(sum.bestReps, pt.maxReps);
            if (pt.e1rm > 0 && pt.e1rm >= sum.bestE1RM) { sum.bestE1RM = pt.e1rm; sum.prDate = s.date; }
            sum.points.push(pt);
            totalSets += pt.sets;
            totalVolume += pt.volume;
        }
    }

    for (const sum of exMap.values()) {
        totalReps += sum.reps;
        sum.repsBased = sum.bestE1RM === 0;
        const metric = (p: SessionPoint) => (sum.repsBased ? p.maxReps : p.e1rm);
        if (sum.repsBased) {
            sum.prDate = sum.points.find(p => p.maxReps === sum.bestReps)?.date ?? "";
        }
        if (sum.points.length >= 2) {
            const a = metric(sum.points[0]);
            const b = metric(sum.points[sum.points.length - 1]);
            if (a > 0) sum.trend = ((b - a) / a) * 100;
        }
    }

    // Streaks across all history
    const weeks = Array.from(new Set(all.map(s => weekIndex(s.date)))).sort((a, b) => a - b);
    let longest = 0, run = 0;
    for (let i = 0; i < weeks.length; i++) {
        run = i > 0 && weeks[i] === weeks[i - 1] + 1 ? run + 1 : 1;
        longest = Math.max(longest, run);
    }
    let current = 0;
    if (weeks.length > 0 && weeks[weeks.length - 1] >= weekIndex(today) - 1) {
        current = 1;
        for (let i = weeks.length - 1; i > 0 && weeks[i] === weeks[i - 1] + 1; i--) current++;
    }

    let avgPerWeek = 0;
    const weekBuckets: WeekBucket[] = [];
    if (inRange.length > 0) {
        const end = weekIndex(today);
        const first = weekIndex(from ?? inRange[0].date);
        avgPerWeek = inRange.length / Math.max(1, end - first + 1);
        // Continuous weekly series, capped at the last 26 weeks
        for (let w = Math.max(first, end - 25); w <= end; w++) {
            weekBuckets.push(weekMap.get(w) ?? { label: weekLabel(w), workouts: 0, volume: 0 });
        }
    }

    return {
        workouts: inRange.length,
        sets: totalSets,
        reps: totalReps,
        volume: totalVolume,
        avgPerWeek,
        currentStreakWeeks: current,
        longestStreakWeeks: longest,
        exercises: Array.from(exMap.values()).sort((a, b) => b.volume - a.volume || b.reps - a.reps),
        muscles: Array.from(muscleSets, ([name, sets]) => ({ name, sets })).sort((a, b) => b.sets - a.sets),
        weeks: weekBuckets,
    };
}
