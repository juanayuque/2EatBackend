// app/group-match/session/[sessionId].tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { auth } from "../../../../firebaseConfig"; // <= correct relative path

const API_BASE = "https://2eatapp.com";
const ACCENT = "#4f46e5";
const TEXT = "#111";
const MUTED = "#666";
const BORDER = "#e5e5ea";
const FALLBACK_IMG = require("../../../../src/assets/images/2Eat-Logo.png");

// ---------- small helpers ----------
const primaryReadable = (pt?: string | null) =>
  pt ? pt.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : null;

function hasParkingHeuristic(r: any): boolean {
  const po = r?.parkingOptions;
  const summary = String(r?.editorial_summary || r?.editorialSummary || "").toLowerCase();
  const hint = summary.includes("parking") || summary.includes("car park") || summary.includes("parking lot");
  if (po && typeof po === "object") return Object.values(po).some(Boolean) || hint;
  return Boolean(po) || hint;
}
function renderBudgetStars(level?: number | null) {
  if (level == null) return "☆☆☆☆  ·  Budget";
  const l = Math.max(0, Math.min(4, level));
  return `${"★".repeat(l)}${"☆".repeat(4 - l)}  ·  Budget`;
}
function pickDeterministic<T>(arr: T[], seed: string, count = 2): T[] {
  if (!arr?.length) return [];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const out: T[] = [];
  const used = new Set<number>();
  for (let i = 0; i < Math.min(count, arr.length); i++) {
    let idx = (h + i * 97) % arr.length;
    while (used.has(idx) && used.size < arr.length) idx = (idx + 1) % arr.length;
    used.add(idx);
    out.push(arr[idx]);
  }
  return out;
}

// ---------- types ----------
type Card = {
  id: string;
  name: string;
  address?: string | null;
  distance?: number | null;
  priceLevel?: number | null;
  photoUrl?: string | null;
  primaryType?: string | null;
  primaryTypeDisplayName?: string | null;
  types?: string[] | null;
  editorialSummary?: string | null;
  editorial_summary?: string | null;
  allowsDogs?: boolean | null;
  parkingOptions?: any;
};

type SessionState = {
  status: "active" | "completed" | string;
  youCount: number;
  partnerCount: number;
  limit: number;
  next?: Card | null;
};

type GroupSessionRow = {
  id: string;
  partner: { id: string; name: string; username?: string | null };
  youCount: number;
  partnerCount: number;
  limit: number;
};

// ---------- component ----------
export default function GroupJoin() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();

  // toast
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toast = (msg: string) => {
    setToastMsg(msg);
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 160, useNativeDriver: true }),
      Animated.delay(1600),
      Animated.timing(toastOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
    ]).start(() => setToastMsg(null));
  };

  const [partnerName, setPartnerName] = useState<string>("Friend");
  const [state, setState] = useState<SessionState | null>(null);

  // current card (set only when id changes to avoid flicker)
  const [card, setCard] = useState<Card | null>(null);
  const lastCardIdRef = useRef<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);

  // comments cache (solo + group matches)
  const [commentsByRestaurant, setCommentsByRestaurant] = useState<Record<string, string[]>>({});

  // my location (used to set locA/locB and sent as headers on /state)
  const [myLoc, setMyLoc] = useState<{ lat: number; lng: number } | null>(null);

  const authedHeaders = useCallback(async () => {
    const t = await auth.currentUser?.getIdToken(true);
    return { Authorization: `Bearer ${t}`, "Content-Type": "application/json" } as Record<string, string>;
  }, []);

  // helper to get browser geolocation (web & native)
  const getBrowserLocation = useCallback(async (): Promise<{ lat: number; lng: number } | null> => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) return null;
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, maximumAge: 60000, timeout: 8000 }
      );
    });
  }, []);

  // On mount: fetch my location and POST it to /session/:id/start (writes locA/locB)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!sessionId) return;
      const loc = await getBrowserLocation();
      if (cancelled) return;
      if (loc) {
        setMyLoc(loc);
        try {
          const headers = await authedHeaders();
          await fetch(`${API_BASE}/api/group/session/${encodeURIComponent(sessionId)}/start`, {
            method: "POST",
            headers,
            body: JSON.stringify({ lat: loc.lat, lng: loc.lng }),
          });
        } catch {}
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, authedHeaders, getBrowserLocation]);

  // load meta (partner name + initial counts) from /api/group/sessions
  const loadMeta = useCallback(async () => {
    if (!sessionId) return;
    try {
      const headers = await authedHeaders();
      const r = await fetch(`${API_BASE}/api/group/sessions`, { headers });
      if (!r.ok) return;
      const j = await r.json();
      const s: GroupSessionRow | undefined = (j?.sessions || []).find((x: any) => x.id === sessionId);
      if (s) {
        setPartnerName(s.partner?.name || "Friend");
        setState((prev) => prev || { status: "active", youCount: s.youCount, partnerCount: s.partnerCount, limit: s.limit });
      }
    } catch {}
  }, [sessionId, authedHeaders]);

  // load live state (and set current card) from /api/group/session/:id/state
  const loadState = useCallback(async () => {
    if (!sessionId) return;
    try {
      const base = await authedHeaders();
      const headers: Record<string, string> = { ...base };
      if (myLoc) {
        headers["X-Geo-Lat"] = String(myLoc.lat);
        headers["X-Geo-Lng"] = String(myLoc.lng);
      }
      const r = await fetch(`${API_BASE}/api/group/session/${encodeURIComponent(sessionId)}/state`, {
        headers,
        cache: "no-store" as any,
      });
      if (!r.ok) throw new Error();
      const j = await r.json();
      const s: SessionState = {
        status: j.status,
        youCount: j.youCount,
        partnerCount: j.partnerCount,
        limit: j.limit,
        next: j.next || null,
      };
      setState(s);

      // only update local card if it changed to avoid flicker
      const nextId = s.next?.id || null;
      if (nextId !== lastCardIdRef.current) {
        lastCardIdRef.current = nextId;
        setCard(s.next || null);
      }
    } catch {
      // swallow; transient network
    } finally {
      setLoading(false);
    }
  }, [sessionId, authedHeaders, myLoc]);

  // pull comments from matches (solo + group)
  const loadComments = useCallback(async () => {
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) return;
      const [r1, r2] = await Promise.all([
        fetch(`${API_BASE}/api/matches`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API_BASE}/api/group/matches`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const [j1, j2] = await Promise.all([r1.ok ? r1.json() : { matches: [] }, r2.ok ? r2.json() : { matches: [] }]);
      const rows: any[] = [...(j1?.matches || []), ...(j2?.matches || [])];
      const map: Record<string, string[]> = {};
      for (const m of rows) {
        const c = (m.userComment || m.comment || "").trim();
        if (!c) continue;
        const ids = [m.winner?.id, m.top1?.id, m.top2?.id, m.top3?.id].filter(Boolean) as string[];
        for (const id of ids) {
          if (!map[id]) map[id] = [];
          map[id].push(c);
        }
      }
      setCommentsByRestaurant(map);
    } catch {}
  }, []);

  // animations (tiny bump on tap)
  const cardScale = useRef(new Animated.Value(1)).current;
  const bump = () => {
    Animated.sequence([
      Animated.timing(cardScale, { toValue: 0.97, duration: 90, useNativeDriver: Platform.OS !== "web" }),
      Animated.timing(cardScale, { toValue: 1, duration: 120, useNativeDriver: Platform.OS !== "web" }),
    ]).start();
  };

  // init
  useEffect(() => {
    loadMeta();
    loadState();
    loadComments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // poll state while active or while you finished but partner hasn't
  useEffect(() => {
    if (!state) return;
    const active = state.status === "active";
    const waitingForPartner = state.youCount >= state.limit && active;
    if (!active && !waitingForPartner) return;
    const id = setInterval(loadState, 3500);
    return () => clearInterval(id);
  }, [state?.status, state?.youCount, state?.limit, loadState]);

  // derived
  const done = state ? state.youCount >= state.limit : false;

  // image with fallback
  function HeroImage({ uri, altKey }: { uri?: string | null; altKey: string }) {
    const [failed, setFailed] = useState(false);
    useEffect(() => setFailed(false), [uri]);
    const source = useMemo(() => {
      if (!uri || failed) return FALLBACK_IMG;
      return { uri };
    }, [uri, failed]);
    return (
      <Image
        key={uri ? `${altKey}:${uri}` : `fallback:${altKey}`}
        source={source as any}
        style={styles.cardImage}
        resizeMode="cover"
        onError={() => setFailed(true)}
      />
    );
  }

  // actions
  const sendFeedback = useCallback(
    async (action: "LIKE" | "PASS" | "SUPERSTAR" = "LIKE") => {
      if (!card || !sessionId) return;
      try {
        setActionBusy(true);
        bump();
        const headers = await authedHeaders();
        const r = await fetch(`${API_BASE}/api/group/session/${encodeURIComponent(sessionId)}/feedback`, {
          method: "POST",
          headers,
          body: JSON.stringify({ restaurantId: card.id, action }),
        });
        if (!r.ok) throw new Error();
        setState((s) => (s ? { ...s, youCount: Math.min(s.limit, s.youCount + 1) } : s));
      } catch {
        toast("Failed to send feedback");
      } finally {
        // after sending, fetch next (server advances based on count)
        setTimeout(loadState, 250);
        setActionBusy(false);
      }
    },
    [card?.id, sessionId, authedHeaders, loadState]
  );

  // comments for current card
  const twoComments = useMemo(() => {
    if (!card) return [];
    const arr = commentsByRestaurant[card.id] || [];
    return pickDeterministic(arr, card.id, 2);
  }, [card?.id, commentsByRestaurant]);

  return (
    <View style={styles.screen}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.greeting}>
            Group Match with <Text style={{ color: ACCENT }}>{partnerName}</Text>
          </Text>
          <Text style={styles.subtitle}>
            {state ? `You ${state.youCount}/${state.limit} · Friend ${state.partnerCount}/${state.limit}` : "Loading…"}
          </Text>
        </View>

        {/* STATES */}
        {!state ? (
          <View style={styles.centerFill}>
            <ActivityIndicator />
            <Text style={{ color: MUTED, marginTop: 6 }}>Loading session…</Text>
          </View>
        ) : state.status === "completed" ? (
          <View style={styles.centerFill}>
            <Text style={{ color: TEXT, fontWeight: "800" }}>Session finished 🎉</Text>
            <Text style={{ color: MUTED, marginTop: 6, textAlign: "center" }}>
              Check “Your Matches” for the winner.
            </Text>
          </View>
        ) : done ? (
          <View style={styles.centerFill}>
            <Text style={{ color: TEXT, fontWeight: "800" }}>You’re done!</Text>
            <Text style={{ color: MUTED, marginTop: 6, textAlign: "center" }}>
              Waiting for your friend ({state.partnerCount}/{state.limit})…
            </Text>
          </View>
        ) : loading && !card ? (
          <View style={styles.centerFill}>
            <ActivityIndicator />
          </View>
        ) : card ? (
          <>
            {/* PASS | IMAGE | LIKE/SUPER */}
            <View style={styles.cardRow}>
              <Pressable
                onPress={() => sendFeedback("PASS")}
                disabled={actionBusy}
                style={({ pressed }) => [
                  styles.sideBtn,
                  (pressed || actionBusy) && styles.sideBtnPressed,
                  actionBusy && { opacity: 0.6 },
                ]}
              >
                <Text style={styles.sideLabel}>Pass</Text>
              </Pressable>

              <Animated.View style={[styles.card, styles.cardSquare, { transform: [{ scale: cardScale }] }]}>
                <HeroImage uri={card.photoUrl} altKey={card.id} />
              </Animated.View>

              <View style={{ gap: 10 }}>
                <Pressable
                  onPress={() => sendFeedback("LIKE")}
                  disabled={actionBusy}
                  style={({ pressed }) => [
                    styles.sideBtn,
                    (pressed || actionBusy) && styles.sideBtnPressed,
                    actionBusy && { opacity: 0.6 },
                  ]}
                >
                  <Text style={styles.sideLabel}>Like</Text>
                </Pressable>
                <Pressable
                  onPress={() => sendFeedback("SUPERSTAR")}
                  disabled={actionBusy}
                  style={({ pressed }) => [
                    styles.sideBtn,
                    styles.superBtn,
                    (pressed || actionBusy) && styles.sideBtnPressed,
                    actionBusy && { opacity: 0.6 },
                  ]}
                >
                  <Text style={[styles.sideLabel, { color: "#fff" }]}>★</Text>
                </Pressable>
              </View>
            </View>

            {/* DETAILS */}
            <View style={styles.details}>
              <Text style={styles.name}>{card.name}</Text>

              {!!card.address && (
                <Text style={styles.address}>
                  {card.address}{"  "}
                  {typeof card.distance === "number" && (
                    <Text style={styles.distance}>• {card.distance.toFixed(1)} km away</Text>
                  )}
                </Text>
              )}

              {(card.primaryType || (card.types && card.types.length)) && (
                <View style={styles.typeRow}>
                  <Text style={styles.typeLabel}>Type: </Text>
                  <Text style={styles.typeFallback}>
                    {primaryReadable(card.primaryType) || "Restaurant"}
                    {Array.isArray(card.types) && card.types.length > 0 && (
                      <>
                        {"  ·  "}
                        {card.types.slice(0, 3).map((t, i) => (
                          <Text key={`t-${i}`}>{i > 0 ? `, ${t.replace(/_/g, " ")}` : t.replace(/_/g, " ")}</Text>
                        ))}
                      </>
                    )}
                  </Text>
                </View>
              )}

              <View style={styles.indicatorsRow}>
                <View
                  style={[
                    styles.indicator,
                    card.allowsDogs ? styles.indicatorOn : styles.indicatorOff,
                  ]}
                >
                  <Text style={card.allowsDogs ? styles.indicatorTextOn : styles.indicatorTextOff}>
                    🐶 Pet friendly: {card.allowsDogs ? "✓" : "✗"}
                  </Text>
                </View>
                <View
                  style={[
                    styles.indicator,
                    hasParkingHeuristic(card) ? styles.indicatorOn : styles.indicatorOff,
                  ]}
                >
                  <Text style={hasParkingHeuristic(card) ? styles.indicatorTextOn : styles.indicatorTextOff}>
                    🅿️ Parking: {hasParkingHeuristic(card) ? "✓" : "✗"}
                  </Text>
                </View>
              </View>

              {!!(card.editorial_summary || card.editorialSummary) && (
                <Text style={styles.summary}>{card.editorial_summary || card.editorialSummary}</Text>
              )}

              <Text style={styles.budget}>{renderBudgetStars(card.priceLevel ?? null)}</Text>

              {/* Comments */}
              <View style={styles.commentsBox}>
                <Text style={styles.commentsTitle}>Comments from users</Text>
                <View style={{ height: 10 }} />
                {twoComments.length ? (
                  twoComments.map((c, idx) => (
                    <View key={`${card.id}-c-${idx}`} style={styles.commentRow}>
                      <View style={styles.avatar}>
                        <Text style={styles.avatarText}>☆</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.commentName}>2Eat user</Text>
                        <Text style={styles.commentText}>{c}</Text>
                      </View>
                    </View>
                  ))
                ) : (
                  <Text style={styles.noComments}>— No comments yet</Text>
                )}
              </View>
            </View>
          </>
        ) : (
          <View style={styles.centerFill}>
            <Text style={{ color: MUTED }}>No more options. One moment…</Text>
          </View>
        )}
      </View>

      {toastMsg && (
        <Animated.View pointerEvents="none" style={[styles.toast, { opacity: toastOpacity }]}>
          <Text style={styles.toastText}>{toastMsg}</Text>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f8fafc" }, // slightly different bg to Home
  container: {
    flex: 1,
    paddingTop: 18,
    paddingHorizontal: 16,
    paddingBottom: 110,
    maxWidth: 520,
    width: "100%",
    alignSelf: "center",
  },
  header: { gap: 4, marginBottom: 14 },
  greeting: { fontSize: 22, fontWeight: "800", color: TEXT, textAlign: "left" },
  subtitle: { fontSize: 14, color: MUTED },

  // center blocks
  centerFill: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },

  // main card row
  cardRow: {
    width: "100%",
    paddingHorizontal: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 22,
  },
  sideBtn: {
    width: 64,
    height: 64,
    borderRadius: 16,
    backgroundColor: "#f2f2f7",
    borderWidth: 1,
    borderColor: BORDER,
    alignItems: "center",
    justifyContent: "center",
  },
  sideBtnPressed: { transform: [{ scale: 0.97 }] },
  superBtn: { backgroundColor: ACCENT, borderColor: ACCENT },
  sideLabel: { fontSize: 16, fontWeight: "700", color: TEXT },

  // square hero
  card: {
    overflow: "hidden",
    backgroundColor: "#f7f7f8",
    borderWidth: 1,
    borderColor: BORDER,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  cardSquare: {
    flex: 1,
    aspectRatio: 1,
    maxWidth: 380,
    minWidth: 180,
    borderRadius: 24,
  },
  cardImage: { width: "100%", height: "100%" },

  // details block
  details: { marginTop: 0, gap: 10, paddingHorizontal: 8 },
  name: { fontSize: 20, fontWeight: "800", color: TEXT, textAlign: "center", marginBottom: 2 },
  address: { marginTop: 2, fontSize: 14, color: "#333", textAlign: "center" },
  distance: { color: "#666" },

  typeRow: {
    marginTop: 2,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "baseline",
    gap: 6,
  },
  typeLabel: { color: "#666", fontSize: 13 },
  typeFallback: { color: TEXT, fontWeight: "700", fontSize: 13 },

  indicatorsRow: {
    marginTop: 8,
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  indicator: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  indicatorOn: { backgroundColor: "#ecfdf5", borderColor: "#a7f3d0" },
  indicatorOff: { backgroundColor: "#fef2f2", borderColor: "#fecaca" },
  indicatorTextOn: { color: "#065f46", fontWeight: "700", fontSize: 12 },
  indicatorTextOff: { color: "#7f1d1d", fontWeight: "700", fontSize: 12 },

  summary: { marginTop: 6, color: "#444", fontSize: 14, textAlign: "center" },
  budget: { marginTop: 6, fontSize: 14, color: TEXT, fontWeight: "700", textAlign: "center" },

  // comments box
  commentsBox: {
    marginTop: 10,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#f5f7ff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    gap: 8,
  },
  commentsTitle: { color: TEXT, fontWeight: "800", fontSize: 14, textAlign: "left" },
  commentRow: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 999,
    backgroundColor: "#e0e7ff",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#3730a3", fontWeight: "800", fontSize: 12 },
  commentName: { color: TEXT, fontWeight: "800", fontSize: 12 },
  commentText: { color: "#333", fontSize: 12, marginTop: 2 },
  noComments: { color: "#666", fontSize: 12, textAlign: "left" },

  // toast
  toast: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 24,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: "rgba(17,17,17,0.92)",
    alignItems: "center",
  },
  toastText: { color: "#fff", fontWeight: "700" },
});
