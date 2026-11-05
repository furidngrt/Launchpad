import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import type { Trade } from "../lib/data";
import { formatPrice, formatPriceNumber } from "../lib/format";

const INTERVALS = [
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3600 },
  { label: "4h", seconds: 14_400 },
];

type Mode = "candles" | "line";

interface Candle {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  up: boolean;
}

const toNumber = (wad: bigint) => Number(wad) / 1e18;

/** Groups trades into candles. Each trade contributes the spot price on both
 * sides of it, so a candle's range is the real range the curve traded across. */
function buildCandles(trades: Trade[], interval: number): Candle[] {
  const candles: Candle[] = [];
  for (const trade of trades) {
    const time = (Math.floor(trade.timestamp / interval) * interval) as UTCTimestamp;
    const before = toNumber(trade.priceBefore);
    const after = toNumber(trade.priceAfter);
    const volume = toNumber(trade.quote);
    const last = candles[candles.length - 1];
    if (last && last.time === time) {
      last.high = Math.max(last.high, before, after);
      last.low = Math.min(last.low, before, after);
      last.close = after;
      last.volume += volume;
      last.up = last.close >= last.open;
    } else {
      // Open where the previous candle closed, so the series has no gaps in price.
      const open = last ? last.close : before;
      candles.push({
        time,
        open,
        high: Math.max(open, before, after),
        low: Math.min(open, before, after),
        close: after,
        volume,
        up: after >= open,
      });
    }
  }
  return candles;
}

function pickInterval(trades: Trade[]): number {
  if (trades.length < 2) return 300;
  const span = trades[trades.length - 1].timestamp - trades[0].timestamp;
  if (span < 3600) return 60;
  if (span < 6 * 3600) return 300;
  if (span < 2 * 86400) return 900;
  if (span < 10 * 86400) return 3600;
  return 14_400;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Colours come from the page's own theme tokens, read when the chart is built
 * and again whenever the theme changes. */
function chartTheme() {
  return {
    background: cssVar("--surface"),
    text: cssVar("--muted"),
    grid: cssVar("--grid"),
    border: cssVar("--border"),
    up: cssVar("--up"),
    down: cssVar("--down"),
    upSoft: cssVar("--up-volume"),
    downSoft: cssVar("--down-volume"),
    line: cssVar("--accent"),
  };
}

export function PriceChart({ trades, loading, priceWad }: { trades: Trade[] | undefined; loading: boolean; priceWad: bigint }) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<{ candles?: ISeriesApi<"Candlestick">; line?: ISeriesApi<"Line">; volume?: ISeriesApi<"Histogram"> }>({});
  const [chosen, setChosen] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>("candles");
  const [themeTick, setThemeTick] = useState(0);

  const list = trades ?? [];
  const activeInterval = chosen ?? pickInterval(list);
  const candles = useMemo(() => buildCandles(list, activeInterval), [list, activeInterval]);

  // Rebuild colours when the theme changes, whether by toggle or by the system.
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeTick((t) => t + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onMedia = () => setThemeTick((t) => t + 1);
    media?.addEventListener?.("change", onMedia);
    return () => {
      observer.disconnect();
      media?.removeEventListener?.("change", onMedia);
    };
  }, []);

  useEffect(() => {
    if (!container.current) return;
    const t = chartTheme();
    const instance = createChart(container.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: t.background },
        textColor: t.text,
        fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: true,
      },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.border, scaleMargins: { top: 0.12, bottom: 0.24 } },
      timeScale: { borderColor: t.border, timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 10 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { priceFormatter: formatPriceNumber },
    });
    const priceFormat = { type: "custom" as const, formatter: formatPriceNumber, base: 1e18 };
    series.current.candles = instance.addSeries(CandlestickSeries, {
      upColor: t.up,
      downColor: t.down,
      borderVisible: false,
      wickUpColor: t.up,
      wickDownColor: t.down,
      priceFormat,
    });
    series.current.line = instance.addSeries(LineSeries, {
      color: t.line,
      lineWidth: 2,
      priceFormat,
      visible: false,
      lastValueVisible: true,
      priceLineVisible: true,
    });
    series.current.volume = instance.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    series.current.volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = instance;
    return () => {
      instance.remove();
      chart.current = null;
      series.current = {};
    };
  }, [themeTick]);

  useEffect(() => {
    const { candles: c, line, volume } = series.current;
    if (!chart.current || !c || !line || !volume) return;
    const t = chartTheme();
    c.setData(candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    line.setData(candles.map(({ time, close }) => ({ time, value: close })));
    volume.setData(candles.map(({ time, volume: v, up }) => ({ time, value: v, color: up ? t.upSoft : t.downSoft })));
    c.applyOptions({ visible: mode === "candles" });
    line.applyOptions({ visible: mode === "line" });
    chart.current.timeScale().fitContent();
  }, [candles, mode, themeTick]);

  return (
    <div className="chart">
      <div className="chart-toolbar">
        <div className="chart-price">
          <span className="label">Price</span>
          <span className="mono">{formatPrice(priceWad)} ETH</span>
        </div>
        <div className="chart-controls">
          <div className="pill-group" role="group" aria-label="Interval">
            {INTERVALS.map((option) => (
              <button
                key={option.label}
                className={`pill-xs ${activeInterval === option.seconds ? "active" : ""}`}
                onClick={() => setChosen(option.seconds)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="pill-group" role="group" aria-label="Chart type">
            <button className={`pill-xs ${mode === "candles" ? "active" : ""}`} onClick={() => setMode("candles")}>
              Candles
            </button>
            <button className={`pill-xs ${mode === "line" ? "active" : ""}`} onClick={() => setMode("line")}>
              Line
            </button>
          </div>
        </div>
      </div>
      <div className="chart-canvas">
        <div ref={container} className="chart-host" />
        {(loading || list.length === 0) && (
          <div className="chart-overlay">
            <span className="muted">{loading ? "Loading trades…" : "No trades yet. The first buy draws the first candle."}</span>
          </div>
        )}
      </div>
    </div>
  );
}
