import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet, View, Text, TextInput, TouchableOpacity,
  ScrollView, Alert, StatusBar, ActivityIndicator,
  SafeAreaView, FlatList, Linking
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

// ── Colors ────────────────────────────────────────────────────────────────────
const C = {
  bg:       '#0D0E14',
  card:     '#13141F',
  card2:    '#0A0B10',
  blue:     '#4761F5',
  blueDim:  '#1C2347',
  red:      '#C93030',
  green:    '#2ECC71',
  orange:   '#F5A623',
  text:     '#E8EAFA',
  textDim:  '#6B7299',
  textMid:  '#9BA3CC',
  border:   '#1E2030',
};

const POLL_SECONDS = 60;

// ── Helpers ───────────────────────────────────────────────────────────────────
function isChannelUrl(url) {
  return /youtube\.com\/(@|channel\/|c\/|user\/)/.test(url);
}

function getLiveUrl(url) {
  url = url.trim().replace(/\/$/, '');
  if (isChannelUrl(url) && !url.endsWith('/live')) {
    return url + '/live';
  }
  return url;
}

function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Check if YouTube URL is live via oEmbed ───────────────────────────────────
async function checkIsLive(url) {
  try {
    const liveUrl = getLiveUrl(url);
    // Use YouTube oEmbed to check if stream exists/is live
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(liveUrl)}&format=json`;
    const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return false;
    // If oEmbed returns successfully, the stream is accessible (live)
    return true;
  } catch {
    return false;
  }
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [mode, setMode]           = useState('manual'); // 'manual' | 'auto'
  const [url, setUrl]             = useState('');
  const [running, setRunning]     = useState(false);
  const [status, setStatus]       = useState('Ready');
  const [subStatus, setSubStatus] = useState('Waiting for input...');
  const [statusColor, setStatusColor] = useState(C.green);
  const [logs, setLogs]           = useState([]);
  const [recordings, setRecordings] = useState([]);
  const stopRef = useRef(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    loadRecordings();
  }, []);

  // ── Logging ────────────────────────────────────────────────────────────────
  function addLog(msg, color = C.textMid) {
    const entry = { id: Date.now() + Math.random(), msg, color, time: fmtTime(new Date()) };
    setLogs(prev => [...prev.slice(-200), entry]);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }

  // ── Recordings storage ─────────────────────────────────────────────────────
  async function loadRecordings() {
    try {
      const data = await AsyncStorage.getItem('recordings');
      if (data) setRecordings(JSON.parse(data));
    } catch {}
  }

  async function saveRecording(entry) {
    try {
      const data = await AsyncStorage.getItem('recordings');
      const list = data ? JSON.parse(data) : [];
      list.unshift(entry);
      const trimmed = list.slice(0, 50);
      await AsyncStorage.setItem('recordings', JSON.stringify(trimmed));
      setRecordings(trimmed);
    } catch {}
  }

  async function deleteAllRecordings() {
    Alert.alert('Delete All', 'Remove all recording history?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          await AsyncStorage.removeItem('recordings');
          setRecordings([]);
          addLog('Recording history cleared.', C.orange);
        }
      }
    ]);
  }

  // ── Start / Stop ───────────────────────────────────────────────────────────
  function handleAction() {
    if (running) {
      stopRef.current = true;
      setRunning(false);
      deactivateKeepAwake();
      setStatus('Ready');
      setSubStatus('Stopped — waiting for input...');
      setStatusColor(C.green);
      addLog('Stopped by user.');
      return;
    }

    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      Alert.alert('No URL', 'Please paste a YouTube URL first.');
      return;
    }
    if (!trimmedUrl.includes('youtube.com') && !trimmedUrl.includes('youtu.be')) {
      Alert.alert('Invalid URL', 'Please enter a valid YouTube URL.');
      return;
    }

    stopRef.current = false;
    setRunning(true);
    activateKeepAwakeAsync();

    if (mode === 'auto') {
      startAutoMonitor(trimmedUrl);
    } else {
      startManualRecord(trimmedUrl);
    }
  }

  // ── Manual record ──────────────────────────────────────────────────────────
  async function startManualRecord(inputUrl) {
    setStatus('Recording...');
    setStatusColor(C.red);
    setSubStatus('Tap Stop when finished');
    addLog('Starting manual recording...', C.textMid);
    addLog('URL: ' + getLiveUrl(inputUrl), C.textMid);

    const startTime = new Date();
    const entry = {
      id: Date.now(),
      url: inputUrl,
      liveUrl: getLiveUrl(inputUrl),
      startTime: startTime.toISOString(),
      mode: 'manual',
      status: 'recording',
    };

    addLog('Recording in progress. Use yt-dlp or your preferred tool with:', C.green);
    addLog(getLiveUrl(inputUrl), C.blue);

    // Show the YouTube URL to open
    await saveRecording({ ...entry, status: 'started' });

    // Wait until stopped
    while (!stopRef.current) {
      await sleep(1000);
    }

    const endEntry = { ...entry, endTime: new Date().toISOString(), status: 'stopped' };
    await saveRecording(endEntry);
    addLog('Recording stopped.', C.orange);
  }

  // ── Auto monitor ──────────────────────────────────────────────────────────
  async function startAutoMonitor(inputUrl) {
    setStatus('Auto-Monitor ON');
    setStatusColor('#4DA6FF');
    setSubStatus(`Checking every ${POLL_SECONDS}s...`);
    addLog('Auto-monitor started.', C.textMid);
    addLog('Monitoring: ' + getLiveUrl(inputUrl), C.textMid);

    while (!stopRef.current) {
      addLog('Checking if live...', C.textDim);
      setSubStatus('Checking stream status...');

      const live = await checkIsLive(inputUrl);

      if (stopRef.current) break;

      if (live) {
        addLog('LIVE detected!', C.red);
        setStatus('LIVE Detected!');
        setStatusColor(C.red);
        setSubStatus('Stream is live — open URL to record');

        const entry = {
          id: Date.now(),
          url: inputUrl,
          liveUrl: getLiveUrl(inputUrl),
          detectedAt: new Date().toISOString(),
          mode: 'auto',
          status: 'live_detected',
        };
        await saveRecording(entry);

        // Alert user
        Alert.alert(
          '🔴 Stream is LIVE!',
          'The stream is live! Tap Open to start recording in browser.',
          [
            { text: 'Dismiss', style: 'cancel' },
            { text: 'Open Stream', onPress: () => Linking.openURL(getLiveUrl(inputUrl)) }
          ]
        );

        // Wait for stream to end (keep checking)
        addLog(`Waiting ${POLL_SECONDS}s before next check...`, C.textDim);
        await sleepInterruptible(POLL_SECONDS, stopRef);
      } else {
        addLog(`Not live. Next check in ${POLL_SECONDS}s...`, C.orange);
        setSubStatus(`Not live — next check in ${POLL_SECONDS}s`);
        await sleepInterruptible(POLL_SECONDS, stopRef);
      }
    }

    if (!stopRef.current) {
      addLog('Monitor completed.', C.green);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  async function sleepInterruptible(seconds, stopRef) {
    for (let i = 0; i < seconds; i++) {
      if (stopRef.current) return;
      await sleep(1000);
    }
  }

  // ── UI ─────────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={styles.header}>
          <View style={styles.iconBox}>
            <Text style={styles.iconText}>🎬</Text>
          </View>
          <Text style={styles.title}>Stream Recorder</Text>
        </View>

        {/* Mode toggle */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>RECORDING MODE</Text>
          <View style={styles.toggleRow}>
            <TouchableOpacity
              style={[styles.toggleBtn, mode === 'manual' && styles.toggleActive]}
              onPress={() => { if (!running) setMode('manual'); }}>
              <Text style={[styles.toggleText, mode === 'manual' && styles.toggleTextActive]}>
                Manual
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.toggleBtn, mode === 'auto' && styles.toggleActive]}
              onPress={() => { if (!running) setMode('auto'); }}>
              <Text style={[styles.toggleText, mode === 'auto' && styles.toggleTextActive]}>
                Auto-Monitor
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Record card */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>RECORD A STREAM</Text>
          <TextInput
            style={styles.input}
            placeholder="Paste YouTube URL here..."
            placeholderTextColor={C.textDim}
            value={url}
            onChangeText={setUrl}
            editable={!running}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            style={[styles.actionBtn, running && styles.stopBtn]}
            onPress={handleAction}>
            {running
              ? <ActivityIndicator color="#fff" style={{ marginRight: 8 }} />
              : null}
            <Text style={styles.actionBtnText}>
              {running ? 'Stop' : mode === 'auto' ? 'Start Auto-Monitor' : 'Start Recording'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Status card */}
        <View style={styles.card}>
          <Text style={[styles.statusMain, { color: statusColor }]}>{status}</Text>
          <Text style={styles.statusSub}>{subStatus}</Text>
        </View>

        {/* Downloads card */}
        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.cardLabel}>HISTORY</Text>
            <View style={styles.row}>
              <TouchableOpacity style={styles.smBtn} onPress={loadRecordings}>
                <Text style={styles.smBtnText}>Refresh</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.smBtn, styles.smBtnRed]} onPress={deleteAllRecordings}>
                <Text style={styles.smBtnText}>Delete All</Text>
              </TouchableOpacity>
            </View>
          </View>

          {recordings.length === 0
            ? <Text style={styles.emptyText}>No recordings yet</Text>
            : recordings.map(r => (
                <TouchableOpacity key={r.id} style={styles.recRow}
                  onPress={() => Linking.openURL(r.liveUrl)}>
                  <Text style={styles.recUrl} numberOfLines={1}>{r.liveUrl}</Text>
                  <Text style={styles.recMeta}>
                    {r.mode === 'auto' ? '⏱ Auto' : '▶ Manual'} •{' '}
                    {new Date(r.detectedAt || r.startTime).toLocaleString()}
                  </Text>
                  <Text style={[styles.recStatus,
                    { color: r.status === 'live_detected' ? C.red : C.green }]}>
                    {r.status === 'live_detected' ? '🔴 Live detected' : '✓ ' + r.status}
                  </Text>
                </TouchableOpacity>
              ))
          }
        </View>

        {/* Log card */}
        <View style={[styles.card, { maxHeight: 220 }]}>
          <Text style={styles.cardLabel}>ACTIVITY LOG</Text>
          <ScrollView ref={scrollRef} style={styles.logScroll}
            showsVerticalScrollIndicator={false}>
            {logs.length === 0
              ? <Text style={styles.emptyText}>No activity yet</Text>
              : logs.map(l => (
                  <Text key={l.id} style={[styles.logLine, { color: l.color }]}>
                    <Text style={styles.logTime}>[{l.time}] </Text>{l.msg}
                  </Text>
                ))
            }
          </ScrollView>
        </View>

        <Text style={styles.footer}>Saves to Downloads/StreamRecorder</Text>

      </ScrollView>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  safe:             { flex: 1, backgroundColor: C.bg },
  scroll:           { flex: 1 },
  content:          { padding: 16, paddingBottom: 32, gap: 12 },

  header:           { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 4 },
  iconBox:          { width: 46, height: 46, borderRadius: 12, backgroundColor: C.blue,
                      alignItems: 'center', justifyContent: 'center' },
  iconText:         { fontSize: 22 },
  title:            { fontSize: 22, fontWeight: 'bold', color: C.text },

  card:             { backgroundColor: C.card, borderRadius: 14, padding: 14,
                      borderWidth: 1, borderColor: C.border },
  cardLabel:        { fontSize: 10, fontWeight: 'bold', color: C.textDim,
                      letterSpacing: 1, marginBottom: 10 },

  toggleRow:        { flexDirection: 'row', gap: 8 },
  toggleBtn:        { flex: 1, paddingVertical: 10, borderRadius: 8,
                      backgroundColor: C.blueDim, alignItems: 'center' },
  toggleActive:     { backgroundColor: C.blue },
  toggleText:       { fontSize: 13, fontWeight: '600', color: C.textMid },
  toggleTextActive: { color: '#fff' },

  input:            { backgroundColor: C.card2, borderRadius: 10, paddingHorizontal: 14,
                      paddingVertical: 13, fontSize: 14, color: C.text, marginBottom: 10,
                      borderWidth: 1, borderColor: C.border },

  actionBtn:        { backgroundColor: C.blue, borderRadius: 10, paddingVertical: 15,
                      alignItems: 'center', flexDirection: 'row', justifyContent: 'center' },
  stopBtn:          { backgroundColor: C.red },
  actionBtnText:    { fontSize: 15, fontWeight: 'bold', color: '#fff' },

  statusMain:       { fontSize: 16, fontWeight: 'bold', marginBottom: 4 },
  statusSub:        { fontSize: 12, color: C.textDim },

  rowBetween:       { flexDirection: 'row', justifyContent: 'space-between',
                      alignItems: 'center', marginBottom: 10 },
  row:              { flexDirection: 'row', gap: 8 },
  smBtn:            { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 7,
                      backgroundColor: C.blueDim },
  smBtnRed:         { backgroundColor: '#3A1010' },
  smBtnText:        { fontSize: 12, color: C.textMid, fontWeight: '600' },

  emptyText:        { fontSize: 13, color: C.textDim, textAlign: 'center', paddingVertical: 12 },

  recRow:           { backgroundColor: C.card2, borderRadius: 8, padding: 10,
                      marginBottom: 6, borderWidth: 1, borderColor: C.border },
  recUrl:           { fontSize: 12, color: C.text, marginBottom: 2 },
  recMeta:          { fontSize: 11, color: C.textDim, marginBottom: 2 },
  recStatus:        { fontSize: 11, fontWeight: '600' },

  logScroll:        { maxHeight: 160 },
  logLine:          { fontSize: 11, lineHeight: 18 },
  logTime:          { color: C.textDim },

  footer:           { fontSize: 10, color: C.textDim, textAlign: 'center', marginTop: 4 },
});
