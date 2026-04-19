import { useState, useEffect, useMemo, useCallback } from 'react';
import { Interval, DateTime, DurationLike } from 'luxon';
import { fromEpochSec, SleepLogic, toISODate } from '../db/logic';
import { GraphResults, SleepSessionRecord } from '../db/types';

const LOADING_TIMEOUT = 300;
const POLL_SIZE = 2;

export type ChunkUnit = 'day' | 'week' | 'month' | 'year';

/**
 * Generates an array of chunk intervals that cover the current view range,
 * plus a buffer of `pollSize` chunks on either side.
 */
const getRequiredChunks = (viewRange: Interval, unit: ChunkUnit, pollSize: number): Interval[] => {
    let currentStart = viewRange.start!.startOf(unit).minus({ [unit + 's']: pollSize });
    const finalEndStart = viewRange.end!.startOf(unit).plus({ [unit + 's']: pollSize });

    const chunks: Interval[] = [];
    while (currentStart <= finalEndStart) {
        chunks.push(Interval.fromDateTimes(currentStart, currentStart.endOf(unit)));
        currentStart = currentStart.plus({ [unit + 's']: 1 });
    }
    return chunks;
};

/** Unique key for the cache based on the chunk's exact start time */
const getChunkKey = (chunk: Interval) => chunk.start!.toISODate()!;

const useStats = (initialRange?: Interval, initialZoom: ChunkUnit = 'week') => {
    const defaultRange = useMemo(() => {
        const now = DateTime.now().startOf('day');
        return initialRange ?? Interval.fromDateTimes(now.minus({ week: 1 }), now);
    }, [initialRange]);

    const [isLoading, setLoading] = useState(false);
    const [currentRange, setCurrentRange] = useState<Interval>(defaultRange);
    
    // Zoom/Milestone separation for later Samsung Health style zooming
    const [chunkUnit, setChunkUnit] = useState<ChunkUnit>(initialZoom);

    // Cache: Map of chunk keys (e.g. "2024-03-11") to an array of sessions
    const [chunksCache, setChunksCache] = useState<Record<string, SleepSessionRecord[]>>({});

    useEffect(() => {
        let isStale = false;
        const requiredChunks = getRequiredChunks(currentRange, chunkUnit, POLL_SIZE);
        
        // Find chunks we haven't fetched yet
        const missingChunks = requiredChunks.filter(chunk => !chunksCache[getChunkKey(chunk)]);

        if (missingChunks.length === 0) return;

        let loadingShown = false;
        const timer = setTimeout(() => {
            setLoading(true);
            loadingShown = true;
        }, LOADING_TIMEOUT);

        const fetchMissingChunks = async () => {
            // To minimize DB calls, we can fetch all missing data in one span
            const fetchStart = missingChunks[0].start!;
            const fetchEnd = missingChunks[missingChunks.length - 1].end!;

            try {
                // const fetchedSessions = await SleepLogic.list({
                const fetchedSessions = await SleepLogic.fakeList({
                    rangeStart: fetchStart,
                    rangeEnd: fetchEnd,
                });

                if (isStale) return;

                console.log(`[Stats] Fetched New Chunks:
                    Unit: ${chunkUnit}
                    Range: ${fetchStart.toLocal()} -> ${fetchEnd.toLocal()}
                    Sessions Found: ${fetchedSessions.length}
                `);

                setChunksCache(prev => {
                    const nextCache = { ...prev };
                    
                    // Initialize empty arrays so we know these chunks were fetched (even if empty)
                    missingChunks.forEach(chunk => {
                        nextCache[getChunkKey(chunk)] = [];
                    });

                    // Bucket sessions into their respective chunks
                    fetchedSessions.forEach(session => {
                        const sStart = fromEpochSec(session.start);
                        const sEnd = fromEpochSec(session.end);
                        const sessionInterval = Interval.fromDateTimes(sStart, sEnd);

                        missingChunks.forEach(chunk => {
                            // If a sleep session crosses a milestone boundary (e.g., Sunday night to Monday morning), 
                            // it will overlap and be placed into both chunk arrays securely.
                            if (chunk.overlaps(sessionInterval)) {
                                nextCache[getChunkKey(chunk)].push(session);
                            }
                        });
                    });

                    return nextCache;
                });

            } finally {
                clearTimeout(timer);
                if (loadingShown && !isStale) setLoading(false);
            }
        };

        fetchMissingChunks();

        return () => {
            isStale = true;
            clearTimeout(timer);
        };
    }, [currentRange, chunkUnit, chunksCache]);

    // 1. Expose Flattened & Deduplicated Fetched Sessions
    const flattenedFetchedSessions = useMemo(() => {
        const allSessions = Object.values(chunksCache).flat();
        
        // Because sleep sessions can span multiple chunks (e.g. crossing midnight into a new week), 
        // they might exist in multiple buckets. Deduplicate by unique start time.
        const deduplicated = Array.from(
            new Map(allSessions.map(s => [s.start, s])).values()
        );

        // Optional: Keep them sorted chronologically
        return deduplicated.sort((a, b) => a.start - b.start);
    }, [chunksCache]);

    // 2. Current Sessions (Filtered specifically to the arbitrary currentRange)
    const currentSessions = useMemo(() => {
        return flattenedFetchedSessions.filter(s => {
            const sessionEnd = fromEpochSec(s.end);
            const sessionStart = fromEpochSec(s.start);
            return sessionEnd >= currentRange.start! && sessionStart <= currentRange.end!;
        });
    }, [flattenedFetchedSessions, currentRange]);

    // 3. Navigation Helpers for continuous infinite-scroll panning
    const panRange = useCallback((duration: DurationLike) => {
        setCurrentRange(prev => Interval.fromDateTimes(
            prev.start!.plus(duration),
            prev.end!.plus(duration)
        ));
    }, []);

    return {
        isLoading,
        
        // State Management
        currentRange,
        setCurrentRange,
        panRange,

        // Zoom Management (Foundation for future refactor)
        chunkUnit,
        setChunkUnit,

        // Data Access
        currentSessions,
        fetchedSessions: flattenedFetchedSessions,
    };
};

export default useStats;