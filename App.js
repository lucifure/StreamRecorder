import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet, View, Text, TextInput, TouchableOpacity,
  Alert, StatusBar, SafeAreaView, FlatList,
  Linking, Vibration,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Notifications from 'expo-notifications';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

const C = {
  bg:        '#111B21',
  surface:   '#1F2C34',
  surface2:  '#2A3942',
  green:     '#00A884',
  greenDark: '#005C4B',
  text:      '#E9EDEF',
  textMid:   '#8696A0',
  textDim:   '#667781',
  red:       '#FF5252',
  redDark:   '#3D1515',
  orange:    '#FFA726',
  border:    '#2A3942',
};

const POLL_SECONDS = 60;
const STORAGE_CHANNELS  = 'monitor_channels_v3';
const STORAGE_DOWNLOADS = 'downloads_v3';

function getLiveUrl(url) {
  url = url.trim().replace(/\/+$/, '');
  if (/youtube\.com\/(@|channel\/|c\/|user\/)/.test(url) && !url.endsWith('/live')) {
    return url + '/live';
  }
  return url;
}

function isValidYouTubeUrl(url) {
  return url.includes('youtube.com') || url.includes('youtu.be');
}

function shortUrl(url) {
  return url
    .replace('https://www.youtube.com/', '')
    .replace('https://youtube.com/', '')
    .replace('http://youtube.com/', '');
}

function fmtTime(date) {
  return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(date) {
  return new Date(date).toLocaleDateString([], { day: '2-digit', month: 'short' });
}

async function checkIsLive(url) {
  const liveUrl = getLiveUrl(url);
  try {
    const res = await fetch(liveUrl, {
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 16; Poco F7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      }
    });
    const html = await res.text();
    return (
      html.includes('"isLiveBroadcast"') ||
      html.includes('"isLive":true') ||
      html.includes('"live_playback":1') ||
      html.includes('liveBroadcastDetails') ||
      html.includes('"isLiveContent":true') ||
      html.includes('hlsManifestUrl') ||
      html.includes('"continuations"') && html.includes('chat') ||
      html.includes('watching now') ||
      (html.includes('watching') && html.includes('LIVE'))
    );
  } catch {
    try {
      const res2 = await fetch(
        'https://www.youtube.com/oembed?url=' + encodeURIComponent(liveUrl) + '&format=json',
        { signal: AbortSignal.timeout(10000) }
      );
      return res2.ok;
    } catch {
      return false;
    }
  }
}

async function sendNotification(title, body) {
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: true },
      trigger: null,
    });
  } catch {}
}

export default function App() {
  const [tab, setTab]             = useState('monitoring');
  const [urlInput, setUrlInput]   = useState('');
  const [channels, setChannels]   = useState([]);
  const [downloads, setDownloads] = useState([]);
  const stopRefs     = useRef({});
  const loopRefs     = useRef({});
  const downloadsRef = useRef([]);

  useEffect(() => {
    requestPermissions();
    loadData();
  }, []);

  useEffect(() => {
    downloadsRef.current = downloads;
  }, [downloads]);

  async function requestPermissions() {
    await Notifications.requestPermissionsAsync();
  }

  async function loadData() {
    try {
      const ch = await AsyncStorage.getItem(STORAGE_CHANNELS);
      const dl = await AsyncStorage.getItem(STORAGE_DOWNLOADS);
      if (dl) {
        const parsed = JSON.parse(dl);
        setDownloads(parsed);
        downloadsRef.current = parsed;
      }
      if (ch) {
        const parsed = JSON.parse(ch).map(c => ({ ...c, status: 'idle', logs: [] }));
        setChannels(parsed);
      }
    } catch {}
  }

  async function saveChannels(list) {
    try { await AsyncStorage.setItem(STORAGE_CHANNELS, JSON.stringify(list)); } catch {}
  }

  async function saveDownloads(list) {
    try { await AsyncStorage.setItem(STORAGE_DOWNLOADS, JSON.stringify(list)); } catch {}
  }

  function addChannel() {
    const url = urlInput.trim();
    if (!url) return;
    if (!isValidYouTubeUrl(url)) {
      Alert.alert('Invalid URL', 'Please enter a valid YouTube channel or video URL.');
      return;
    }
    setChannels(prev => {
      if (prev.find(c => c.url === url)) {
        Alert.alert('Already added', 'This channel is already being monitored.');
        return prev;
      }
      const newCh = {
        id: Date.now().toString(),
        url,
        liveUrl: getLiveUrl(url),
        status: 'idle',
        logs: [],
        addedAt: new Date().toISOString(),
      };
      const updated = [newCh, ...prev];
      saveChannels(updated);
      setTimeout(() => startMonitor(newCh.id, url), 100);
      return updated;
    });
    setUrlInput('');
  }

  function channelLog(id, msg, color) {
    setChannels(prev => prev.map(c =>
      c.id === id
        ? { ...c, logs: [...(c.logs || []).slice(-20),
            { msg, color: color || C.textMid, time: fmtTime(new Date()) }] }
        : c
    ));
  }

  function setChannelStatus(id, status) {
    setChannels(prev => prev.map(c => c.id === id ? { ...c, status } : c));
  }

  async function startMonitor(id, url) {
    if (loopRefs.current[id]) return;
    stopRefs.current[id] = false;
    loopRefs.current[id] = true;
    activateKeepAwakeAsync();
    setChannelStatus(id, 'checking');
    channelLog(id, 'Monitor started. Wake lock ON.', C.green);

    while (!stopRefs.current[id]) {
      setChannelStatus(id, 'checking');
      channelLog(id, 'Checking live status...', C.textDim);
      const live = await checkIsLive(url);
      if (stopRefs.current[id]) break;

      if (live) {
        setChannelStatus(id, 'live');
        channelLog(id, 'LIVE DETECTED!', C.red);
        Vibration.vibrate([0, 500, 200, 500, 200, 500]);
        await sendNotification('Stream is LIVE!', shortUrl(getLiveUrl(url)) + ' just went live!');

        const dlEntry = {
          id: Date.now().toString(),
          channelUrl: url,
          liveUrl: getLiveUrl(url),
          detectedAt: new Date().toISOString(),
          status: 'live',
        };
        const updatedDl = [dlEntry, ...downloadsRef.current];
        setDownloads(updatedDl);
        downloadsRef.current = updatedDl;
        saveDownloads(updatedDl);

        setChannelStatus(id, 'recording');
        channelLog(id, 'Stream is live! Monitoring...', C.red);

        let stillLive = true;
        while (stillLive && !stopRefs.current[id]) {
          await sleepI(POLL_SECONDS, id);
          if (stopRefs.current[id]) break;
          channelLog(id, 'Re-checking stream...', C.textDim);
          stillLive = await checkIsLive(url);
        }

        if (!stopRefs.current[id]) {
          channelLog(id, 'Stream ended. Resuming monitor...', C.orange);
          await sendNotification('Stream ended', shortUrl(url) + ' stream has ended.');
          setDownloads(prev => {
            const upd = prev.map(d =>
              d.id === dlEntry.id
                ? { ...d, status: 'ended', endedAt: new Date().toISOString() }
                : d
            );
            saveDownloads(upd);
            downloadsRef.current = upd;
            return upd;
          });
        }
      } else {
        channelLog(id, 'Not live. Retry in ' + POLL_SECONDS + 's...', C.textDim);
        await sleepI(POLL_SECONDS, id);
      }
    }

    loopRefs.current[id] = false;
    setChannelStatus(id, 'stopped');
    channelLog(id, 'Monitor stopped.', C.textMid);
    const anyRunning = Object.values(loopRefs.current).some(Boolean);
    if (!anyRunning) deactivateKeepAwake();
  }

  function stopMonitor(id) { stopRefs.current[id] = true; }

  function restartMonitor(id, url) {
    stopRefs.current[id] = false;
    startMonitor(id, url);
  }

  function removeChannel(id) {
    Alert.alert('Remove Channel', 'Stop and remove this channel?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => {
        stopRefs.current[id] = true;
        setChannels(prev => {
          const upd = prev.filter(c => c.id !== id);
          saveChannels(upd);
          return upd;
        });
      }}
    ]);
  }

  async function sleepI(seconds, id) {
    for (let i = 0; i < seconds; i++) {
      if (stopRefs.current[id]) return;
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  const activeCount = channels.filter(c => ['checking','live','recording'].includes(c.status)).length;
  const liveCount   = channels.filter(c => ['live','recording'].includes(c.status)).length;

  function Badge({ status }) {
    const map = {
      idle:      { label: 'Idle',     bg: C.surface2,  fg: C.textDim },
      checking:  { label: 'Checking', bg: C.greenDark, fg: C.green   },
      live:      { label: 'LIVE',     bg: C.redDark,   fg: C.red     },
      recording: { label: 'Live',     bg: C.redDark,   fg: C.red     },
      stopped:   { label: 'Stopped',  bg: C.surface2,  fg: C.textDim },
    };
    const s = map[status] || map.idle;
    return (
      <View style={[S.badge, { backgroundColor: s.bg }]}>
        <Text style={[S.badgeTxt, { color: s.fg }]}>{s.label}</Text>
      </View>
    );
  }

  function ChannelCard({ item }) {
    const running = ['checking','live','recording'].includes(item.status);
    const lastLog = (item.logs || []).slice(-1)[0];
    return (
      <View style={S.card}>
        <View style={S.cardRow}>
          <View style={S.avatar}>
            <Text style={S.avatarTxt}>{shortUrl(item.url)[0]?.toUpperCase() || 'Y'}</Text>
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={S.cardUrl} numberOfLines={1}>{shortUrl(item.url)}</Text>
            <Badge status={item.status} />
          </View>
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
            {running
              ? <TouchableOpacity style={S.btnStop} onPress={() => stopMonitor(item.id)}>
                  <Text style={S.btnStopTxt}>Stop</Text>
                </TouchableOpacity>
              : <TouchableOpacity style={S.btnStart} onPress={() => restartMonitor(item.id, item.url)}>
                  <Text style={S.btnStartTxt}>Start</Text>
                </TouchableOpacity>
            }
            <TouchableOpacity onPress={() => removeChannel(item.id)} style={S.btnX}>
              <Text style={S.btnXTxt}>X</Text>
            </TouchableOpacity>
          </View>
        </View>
        {lastLog &&
          <Text style={[S.lastLog, { color: lastLog.color }]} numberOfLines={1}>
            [{lastLog.time}] {lastLog.msg}
          </Text>
        }
        {['live','recording'].includes(item.status) &&
          <TouchableOpacity style={S.openBtn} onPress={() => Linking.openURL(item.liveUrl)}>
            <Text style={S.openBtnTxt}>Open Live Stream</Text>
          </TouchableOpacity>
        }
      </View>
    );
  }

  function DlCard({ item }) {
    return (
      <TouchableOpacity style={S.dlCard} onPress={() => Linking.openURL(item.liveUrl)}>
        <View style={[S.avatar, { backgroundColor: item.status === 'live' ? C.redDark : C.greenDark }]}>
          <Text style={[S.avatarTxt, { color: item.status === 'live' ? C.red : C.green }]}>P</Text>
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={S.cardUrl} numberOfLines={1}>{shortUrl(item.liveUrl)}</Text>
          <Text style={S.metaTxt}>Detected: {fmtDate(item.detectedAt)} at {fmtTime(item.detectedAt)}</Text>
          {item.endedAt && <Text style={S.metaTxt}>Ended: {fmtTime(item.endedAt)}</Text>}
        </View>
        <View style={[S.badge, { backgroundColor: item.status === 'live' ? C.redDark : C.greenDark }]}>
          <Text style={[S.badgeTxt, { color: item.status === 'live' ? C.red : C.green }]}>
            {item.status === 'live' ? 'Live' : 'Ended'}
          </Text>
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <SafeAreaView style={S.safe}>
      <StatusBar barStyle="light-content" backgroundColor={C.surface} />

      <View style={S.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={S.logoBox}><Text style={S.logoTxt}>🔴</Text></View>
          <Text style={S.headerTitle}>Stream Recorder</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {activeCount > 0 &&
            <View style={[S.pill, { backgroundColor: C.greenDark }]}>
              <Text style={[S.pillTxt, { color: C.green }]}>{activeCount} active</Text>
            </View>
          }
          {liveCount > 0 &&
            <View style={[S.pill, { backgroundColor: C.redDark }]}>
              <Text style={[S.pillTxt, { color: C.red }]}>{liveCount} live</Text>
            </View>
          }
        </View>
      </View>

      <View style={S.tabBar}>
        {['monitoring','downloads'].map(t => (
          <TouchableOpacity key={t} style={[S.tab, tab === t && S.tabOn]} onPress={() => setTab(t)}>
            <Text style={[S.tabTxt, tab === t && S.tabTxtOn]}>
              {t === 'monitoring'
                ? 'MONITORING' + (channels.length ? ' (' + channels.length + ')' : '')
                : 'DOWNLOADS' + (downloads.length ? ' (' + downloads.length + ')' : '')
              }
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'monitoring' && (
        <View style={{ flex: 1 }}>
          <View style={S.addBar}>
            <TextInput
              style={S.input}
              placeholder="Paste YouTube channel URL..."
              placeholderTextColor={C.textDim}
              value={urlInput}
              onChangeText={setUrlInput}
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={addChannel}
              returnKeyType="done"
            />
            <TouchableOpacity style={S.addBtn} onPress={addChannel}>
              <Text style={S.addBtnTxt}>Add</Text>
            </TouchableOpacity>
          </View>
          {channels.length === 0
            ? <View style={S.empty}>
                <Text style={{ fontSize: 52 }}>📡</Text>
                <Text style={S.emptyTitle}>No channels yet</Text>
                <Text style={S.emptyTxt}>Paste a YouTube channel URL above{'\n'}to start monitoring</Text>
              </View>
            : <FlatList
                data={channels}
                keyExtractor={i => i.id}
                renderItem={({ item }) => <ChannelCard item={item} />}
                contentContainerStyle={{ padding: 12, gap: 10 }}
                showsVerticalScrollIndicator={false}
              />
          }
        </View>
      )}

      {tab === 'downloads' && (
        <View style={{ flex: 1 }}>
          <View style={S.dlTopBar}>
            <Text style={S.dlTopTitle}>Stream History</Text>
            {downloads.length > 0 &&
              <TouchableOpacity onPress={() => Alert.alert('Clear All', 'Remove all history?', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Clear', style: 'destructive', onPress: () => { setDownloads([]); saveDownloads([]); } }
              ])}>
                <Text style={{ color: C.red, fontSize: 13 }}>Clear All</Text>
              </TouchableOpacity>
            }
          </View>
          {downloads.length === 0
            ? <View style={S.empty}>
                <Text style={{ fontSize: 52 }}>📥</Text>
                <Text style={S.emptyTitle}>No streams recorded</Text>
                <Text style={S.emptyTxt}>Detected streams will appear here</Text>
              </View>
            : <FlatList
                data={downloads}
                keyExtractor={i => i.id}
                renderItem={({ item }) => <DlCard item={item} />}
                contentContainerStyle={{ padding: 12, gap: 8 }}
                showsVerticalScrollIndicator={false}
              />
          }
        </View>
      )}
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe:        { flex: 1, backgroundColor: C.bg },
  header:      { backgroundColor: C.surface, paddingHorizontal: 16, paddingVertical: 12,
                 flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerTitle: { fontSize: 19, fontWeight: 'bold', color: C.text },
  logoBox:     { width: 38, height: 38, borderRadius: 8, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  logoTxt:     { fontSize: 22 },
  pill:        { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12 },
  pillTxt:     { fontSize: 11, fontWeight: '600' },
  tabBar:      { flexDirection: 'row', backgroundColor: C.surface,
                 borderBottomWidth: 1, borderBottomColor: C.border },
  tab:         { flex: 1, paddingVertical: 13, alignItems: 'center',
                 borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabOn:       { borderBottomColor: C.green },
  tabTxt:      { fontSize: 12, fontWeight: '700', color: C.textMid, letterSpacing: 0.5 },
  tabTxtOn:    { color: C.green },
  addBar:      { flexDirection: 'row', padding: 10, gap: 8, backgroundColor: C.surface,
                 borderBottomWidth: 1, borderBottomColor: C.border },
  input:       { flex: 1, backgroundColor: C.surface2, borderRadius: 22,
                 paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, color: C.text },
  addBtn:      { backgroundColor: C.green, borderRadius: 22,
                 paddingHorizontal: 16, justifyContent: 'center' },
  addBtnTxt:   { color: '#fff', fontWeight: 'bold', fontSize: 14 },
  card:        { backgroundColor: C.surface, borderRadius: 12, padding: 12,
                 borderWidth: 1, borderColor: C.border },
  cardRow:     { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar:      { width: 42, height: 42, borderRadius: 21, backgroundColor: C.greenDark,
                 alignItems: 'center', justifyContent: 'center' },
  avatarTxt:   { fontSize: 17, color: C.green, fontWeight: 'bold' },
  cardUrl:     { fontSize: 13, color: C.text, fontWeight: '600' },
  badge:       { alignSelf: 'flex-start', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10 },
  badgeTxt:    { fontSize: 10, fontWeight: 'bold' },
  btnStop:     { backgroundColor: C.redDark, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  btnStopTxt:  { color: C.red, fontWeight: 'bold', fontSize: 12 },
  btnStart:    { backgroundColor: C.greenDark, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  btnStartTxt: { color: C.green, fontWeight: 'bold', fontSize: 12 },
  btnX:        { padding: 5 },
  btnXTxt:     { color: C.textDim, fontSize: 16 },
  lastLog:     { fontSize: 11, marginTop: 8, paddingLeft: 52 },
  openBtn:     { marginTop: 10, marginLeft: 52, backgroundColor: C.redDark,
                 borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  openBtnTxt:  { color: C.red, fontWeight: 'bold', fontSize: 12 },
  dlTopBar:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                 padding: 14, borderBottomWidth: 1, borderBottomColor: C.border },
  dlTopTitle:  { fontSize: 14, fontWeight: 'bold', color: C.text },
  dlCard:      { backgroundColor: C.surface, borderRadius: 10, padding: 12,
                 flexDirection: 'row', alignItems: 'center', gap: 10,
                 borderWidth: 1, borderColor: C.border },
  metaTxt:     { fontSize: 11, color: C.textDim },
  empty:       { flex: 1, alignItems: 'center', justifyConten
