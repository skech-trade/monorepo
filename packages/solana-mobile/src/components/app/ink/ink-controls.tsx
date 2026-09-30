import { CheckIcon, ChevronDownIcon } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { POINT_PRICES } from "@skech/core/odds";
import { Popover, useColors } from "@/components/ui";
import type { Brush } from "@/lib/practice";
import { cn } from "@/lib/utils";

/**
 * The game's two settings, in the dock: the pen (how wide the ink is) and what one dot costs, each a pill wearing
 * its value that opens a card above it. As on the web (ui/app/src/components/app/ink/ink-controls.tsx).
 */

export const PENS: { id: Brush; name: string; dot: number; says: string }[] = [
  { id: "fine", name: "Fine", dot: 9, says: "Higher multiples" },
  { id: "medium", name: "Medium", dot: 14, says: "Balanced" },
  { id: "wide", name: "Wide", dot: 18, says: "More coverage" },
];
export const penFor = (id: Brush) => PENS.find((p) => p.id === id) ?? PENS[1];
export const amountLabel = (n: number) => `$${Number(n.toFixed(2))}`;

const Dot = ({ size }: { size: number }) => <View className="rounded-full bg-brand" style={{ width: size, height: size }} />;

function DockButton({ onPress, children, label }: { onPress: () => void; children: React.ReactNode; label: string }) {
  return (
    <Pressable accessibilityLabel={label} className="h-12 min-w-0 flex-1 flex-row items-center justify-center gap-2 rounded-full bg-raised px-3" onPress={onPress} style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.97 : 1 }] })}>
      {children}
    </Pressable>
  );
}

export function InkControls({ pen, amount, onPen, onAmount, bottom }: { pen: Brush; amount: number; onPen: (id: Brush) => void; onAmount: (n: number) => void; bottom: number }) {
  const c = useColors();
  const [open, setOpen] = useState<"pen" | "amount" | null>(null);
  return (
    <View className="min-w-0 flex-1 flex-row gap-2">
      <DockButton label={`Pen: ${penFor(pen).name}`} onPress={() => setOpen("pen")}>
        <Dot size={penFor(pen).dot} />
        <Text className="font-semibold text-[16px] text-foreground">{penFor(pen).name}</Text>
        <ChevronDownIcon color={c.muted} size={14} />
      </DockButton>
      <DockButton label={`${amountLabel(amount)} per dot`} onPress={() => setOpen("amount")}>
        <Text className="font-semibold text-[16px] text-foreground" style={{ fontVariant: ["tabular-nums"] }}>
          {amountLabel(amount)}
        </Text>
        <ChevronDownIcon color={c.muted} size={14} />
      </DockButton>

      <Popover anchor={{ bottom: bottom + 76, left: 16 }} onClose={() => setOpen(null)} open={open === "pen"} width={224}>
        <Text className="px-2 pt-2 font-semibold text-[15px] text-foreground">Pen size</Text>
        <View className="mt-2 gap-1">
          {PENS.map((p) => (
            <Pressable
              accessibilityLabel={`Use ${p.name} pen`}
              className="h-12 flex-row items-center gap-3 rounded-xl px-3"
              key={p.id}
              onPress={() => {
                onPen(p.id);
                setOpen(null);
              }}
              style={({ pressed }) => ({ backgroundColor: pressed ? "rgba(127,127,127,0.12)" : "transparent" })}
            >
              <View className="w-6 items-center justify-center">
                <Dot size={p.dot} />
              </View>
              <Text className="flex-1 text-[16px] text-foreground">{p.name}</Text>
              {pen === p.id ? <CheckIcon color={c.fg} size={18} /> : null}
            </Pressable>
          ))}
        </View>
      </Popover>

      <Popover anchor={{ bottom: bottom + 76, right: 16 }} onClose={() => setOpen(null)} open={open === "amount"} width={272}>
        <Text className="px-2 pt-2 font-semibold text-[15px] text-foreground">Per dot</Text>
        <View accessibilityRole="radiogroup" className="mt-3 flex-row flex-wrap gap-1.5 px-1">
          {POINT_PRICES.values.map((n) => (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: n === amount }}
              className={cn("h-10 items-center justify-center rounded-[10px]", n === amount ? "bg-primary" : "bg-muted")}
              key={n}
              onPress={() => {
                onAmount(n);
                setTimeout(() => setOpen(null), 120);
              }}
              style={{ width: "18.4%" }}
            >
              <Text className={cn("font-semibold text-[13px]", n === amount ? "text-primary-foreground" : "text-foreground")} style={{ fontVariant: ["tabular-nums"] }}>
                {amountLabel(n)}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text className="mt-3 px-2 pb-2 text-[12px] text-muted-foreground">A hit pays it times its multiple.</Text>
      </Popover>
    </View>
  );
}
