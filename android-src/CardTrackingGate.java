package io.github.rachid598.glucovision;

import java.util.ArrayDeque;

/**
 * Porte temporelle pure du suivi carte. Une pose FULL_TRACKING isolee ne suffit
 * jamais : la carte doit rester visible et produire plusieurs echelles proches.
 * La moindre perte de suivi vide immediatement la fenetre (fail-closed).
 */
final class CardTrackingGate {
    static final int REQUIRED_OBSERVATIONS = 4;
    static final long MIN_OBSERVATION_SEPARATION_MS = 100;
    static final long MIN_STABLE_SPAN_MS = 300;
    static final long MAX_OBSERVATION_AGE_MS = 1500;
    static final long FRESH_MAX_AGE_MS = 250;
    static final double MAX_DISTANCE_SPREAD_CM = 3.0;
    static final double MAX_RELATIVE_FIELD_SPREAD = 0.05;
    static final double MAX_INCIDENCE_SPREAD_DEG = 5.0;

    private final ArrayDeque<Entry> entries = new ArrayDeque<>();
    private CardGeometry.Result current;
    private long currentAtMs = Long.MIN_VALUE;

    synchronized void observe(CardGeometry.Result result, long nowMs) {
        if (result == null || !result.ok || nowMs < 0) {
            lost();
            return;
        }
        current = result;
        currentAtMs = nowMs;
        prune(nowMs);
        Entry last = entries.peekLast();
        if (last != null && nowMs - last.atMs < MIN_OBSERVATION_SEPARATION_MS) return;
        if (last != null && grosslyDifferent(last.result, result)) entries.clear();
        entries.addLast(new Entry(result, nowMs));
        while (entries.size() > 12) entries.removeFirst();
    }

    synchronized void lost() {
        entries.clear();
        current = null;
        currentAtMs = Long.MIN_VALUE;
    }

    synchronized boolean ready(long nowMs) {
        prune(nowMs);
        if (current == null || currentAtMs == Long.MIN_VALUE
                || nowMs - currentAtMs > FRESH_MAX_AGE_MS
                || entries.size() < REQUIRED_OBSERVATIONS) return false;

        Entry[] samples = entries.toArray(new Entry[0]);
        int start = samples.length - REQUIRED_OBSERVATIONS;
        if (samples[samples.length - 1].atMs - samples[start].atMs < MIN_STABLE_SPAN_MS) {
            return false;
        }
        double dMin = Double.POSITIVE_INFINITY, dMax = 0;
        double wMin = Double.POSITIVE_INFINITY, wMax = 0;
        double hMin = Double.POSITIVE_INFINITY, hMax = 0;
        double iMin = Double.POSITIVE_INFINITY, iMax = 0;
        for (int i = start; i < samples.length; i++) {
            CardGeometry.Result value = samples[i].result;
            dMin = Math.min(dMin, value.distanceCm); dMax = Math.max(dMax, value.distanceCm);
            wMin = Math.min(wMin, value.fieldWidthCm); wMax = Math.max(wMax, value.fieldWidthCm);
            hMin = Math.min(hMin, value.fieldHeightCm); hMax = Math.max(hMax, value.fieldHeightCm);
            iMin = Math.min(iMin, value.incidenceDeg); iMax = Math.max(iMax, value.incidenceDeg);
        }
        return dMax - dMin <= MAX_DISTANCE_SPREAD_CM
                && relativeSpread(wMin, wMax) <= MAX_RELATIVE_FIELD_SPREAD
                && relativeSpread(hMin, hMax) <= MAX_RELATIVE_FIELD_SPREAD
                && iMax - iMin <= MAX_INCIDENCE_SPREAD_DEG;
    }

    synchronized int observations(long nowMs) {
        prune(nowMs);
        return Math.min(REQUIRED_OBSERVATIONS, entries.size());
    }

    synchronized CardGeometry.Result current(long nowMs) {
        return ready(nowMs) ? current : null;
    }

    private void prune(long nowMs) {
        while (!entries.isEmpty() && nowMs - entries.peekFirst().atMs > MAX_OBSERVATION_AGE_MS) {
            entries.removeFirst();
        }
    }

    private static boolean grosslyDifferent(CardGeometry.Result a, CardGeometry.Result b) {
        return Math.abs(a.distanceCm - b.distanceCm) > MAX_DISTANCE_SPREAD_CM * 2.0
                || relativeError(a.fieldWidthCm, b.fieldWidthCm) > MAX_RELATIVE_FIELD_SPREAD * 2.0
                || relativeError(a.fieldHeightCm, b.fieldHeightCm) > MAX_RELATIVE_FIELD_SPREAD * 2.0;
    }

    private static double relativeSpread(double min, double max) {
        return min > 0 ? (max - min) / min : Double.POSITIVE_INFINITY;
    }

    private static double relativeError(double a, double b) {
        return Math.abs(a - b) / Math.max(Math.min(a, b), 1e-9);
    }

    private static final class Entry {
        final CardGeometry.Result result;
        final long atMs;

        Entry(CardGeometry.Result result, long atMs) {
            this.result = result;
            this.atMs = atMs;
        }
    }
}
