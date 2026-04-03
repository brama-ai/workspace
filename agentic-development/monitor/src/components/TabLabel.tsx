import React from "react";
import { Text } from "ink";

export function TabLabel({ n, label, active, hasAlert }: { n: number; label: string; active: boolean; hasAlert?: boolean }) {
  const badge = hasAlert ? " ⚠" : "";
  return active ? (
    <Text bold inverse color={hasAlert ? "red" : undefined}> {n}:{label}{badge} </Text>
  ) : (
    <Text dimColor color={hasAlert ? "red" : undefined}> {n}:{label}{badge} </Text>
  );
}
