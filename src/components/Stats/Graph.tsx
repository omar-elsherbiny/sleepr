import React, { memo, useMemo, useState, useCallback, useEffect } from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import {
    useSharedValue,
    withTiming,
    Easing,
    useDerivedValue,
    withDecay,
    runOnJS
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Canvas, Group, RoundedRect, SkFont, Text as SkiaText, useFont } from '@shopify/react-native-skia';
import * as Haptics from 'expo-haptics';
import { DateTime, Interval } from 'luxon';
import { StatsLogic } from '../../db/logic';
import { GraphDataPoint, GraphResults, SleepSessionRecord } from '../../db/types';
import { scheduleOnRN } from 'react-native-worklets';

interface GraphProps {
    width: number;
    height: number;

    fetchedSessions: SleepSessionRecord[];
    currentRange: Interval;
    setCurrentRange: React.Dispatch<React.SetStateAction<Interval>>;

    style?: StyleProp<ViewStyle>;
}

const BAR_WIDTH = 40;
const GAP = 20;
const UNIT_WIDTH = BAR_WIDTH + GAP;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PIXELS_PER_MS = UNIT_WIDTH / MS_PER_DAY;

export default function Graph({
    width,
    height,

    fetchedSessions,
    currentRange,
    setCurrentRange,

    style,
}: GraphProps) {
    const font = useFont(require('../../../assets/fonts/Mona Sans/TTF/MonaSans-Regular.ttf'), 12);

    const [anchorDate] = useState(() => currentRange.start!.startOf('day'));

    // Data
    const graphData: GraphResults = useMemo(() => {
        if (!fetchedSessions || fetchedSessions.length === 0) return {};
        const maxBarHeight = height * 0.7; // Leave 30% padding for text and aesthetics
        return StatsLogic.getGraph(
            fetchedSessions,
            maxBarHeight,
            //  currentRange
        );
    }, [fetchedSessions, currentRange, height]);

    const dataArray = Object.entries(graphData);

    // Gesture
    const translateX = useSharedValue<number>(0);

    const handleScrollEnd = useCallback((finalTx: number) => {
        // Calculate the physical time window visible on the screen based on the camera position
        const shiftMs = -finalTx / PIXELS_PER_MS;
        const visibleStartMs = anchorDate.toMillis() + shiftMs;
        const visibleEndMs = visibleStartMs + (width / PIXELS_PER_MS);

        const newStart = DateTime.fromMillis(visibleStartMs);
        const newEnd = DateTime.fromMillis(visibleEndMs);

        // Update the hook, which triggers fetching chunks and rescaling!
        setCurrentRange(Interval.fromDateTimes(newStart, newEnd));

        // Haptic pop when snapping/rescaling occurs like Samsung Health
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }, [anchorDate, width, setCurrentRange]);

    const pan = Gesture.Pan()
        .onUpdate((event) => {
            translateX.value += event.translationX;
        })
        .onEnd((event) => {
            translateX.value = withDecay({
                velocity: event.velocityX,
                deceleration: 0.994, // Smooth, heavy friction
            }, (finished) => {
                if (finished) {
                    scheduleOnRN(handleScrollEnd, translateX.value);
                    // runOnJS(handleScrollEnd)(translateX.value);
                }
            });;
        });
    const pinch = Gesture.Pinch()
        .onUpdate((event) => {
            // scaleX.value = savedScaleX.value * e.scale;
        })
        .onEnd((event) => {
            // savedScaleX.value = scaleX.value;
        });

    const gesture = Gesture.Simultaneous(pan, pinch);

    const groupTranslation = useDerivedValue(() => [{ translateX: translateX.value }]);

    return (
        <GestureDetector gesture={gesture}>
            <View style={[styles.container, { width, height, borderRadius: width * 0.12 }, style]}>
                <Canvas style={{ flex: 1 }}>
                    <Group transform={groupTranslation}>
                        {dataArray.map(([dateISO, point]) => (
                            <Bar
                                key={dateISO}
                                dateISO={dateISO}
                                point={point}
                                height={height}
                                font={font!}
                                anchorDate={anchorDate}
                            />
                        ))}
                    </Group>
                </Canvas>
            </View>
        </GestureDetector>
    );
};

const Bar = memo(({ dateISO, point, height, font, anchorDate }: {
    dateISO: string;
    point: GraphDataPoint;
    height: number;
    font: SkFont | null;
    anchorDate: DateTime;
}) => {
    // 1. Calculate absolute X position relative to the anchor coordinate system
    const baseCanvasX = useMemo(() => {
        const barDate = DateTime.fromISO(dateISO).startOf('day');
        const diffMs = barDate.diff(anchorDate).milliseconds;
        return diffMs * PIXELS_PER_MS;
    }, [dateISO, anchorDate]);

    // 2. Smoothly animate height changes when the graph rescales
    const animHeight = useDerivedValue(() => {
        return withTiming(point.height, { duration: 400, easing: Easing.out(Easing.cubic) });
    }, [point.height]);

    // 3. Keep the bar anchored to the bottom as it grows/shrinks
    const y = useDerivedValue(() => {
        return height - animHeight.value - 30; // 30px padding from the bottom
    });

    const textY = useDerivedValue(() => {
        return y.value - 10; // Floating 10px above the bar
    });

    if (!font) return null;

    return (
        <>
            <RoundedRect
                x={baseCanvasX}
                y={y}
                width={BAR_WIDTH}
                height={animHeight}
                r={8}
                color="#ffffff"
            />
            <SkiaText
                x={baseCanvasX}
                y={textY}
                text={point.durationTime}
                font={font}
                color="white"
            />
        </>
    );
});

const styles = StyleSheet.create({
    container: {
        borderCurve: "continuous",
        borderColor: "#ffffff99",
        borderWidth: 2,
        paddingHorizontal: 10,
        backgroundColor: "transparent",
    },
});