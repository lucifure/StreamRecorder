import React,{useState,useEffect,useRef}from'react';
import{StyleSheet,View,Text,TextInput,TouchableOpacity,Alert,StatusBar,SafeAreaView,FlatList,Linking,Vibration}from'react-native';
import AsyncStorage from'@react-native-async-storage/async-storage';
import{activateKeepAwakeAsync,deactivateKeepAwake}from'expo-keep-awake';
import*as Notifications from'expo-notifications';

Notifications.setNotificationHandler({handleNotification:async()=>({shouldShowAlert:true,shouldPlaySound:true,shouldSetBadge:true})});

const C={bg:'#111B21',surface:'#1F2C34',surface2:'#2A3942',green:'#00A884',greenDark:'#005C4B',text:'#E9EDEF',textMid:'#8696A0',textDim:'#667781',red:'#FF5252',redDark:'#3D1515',orange:'#FFA726',border:'#2A3942'};
const POLL=60;
const CH_KEY='channels_v3';
const DL_KEY='downloads_v3';

function getLiveUrl(url){
  url=url.trim().replace(/\/+$/,'');
  if(/youtube\.com\/(@|channel\/|c\/|user\/)/.test(url)&&!url.endsWith('/live'))return url+'/live';
  return url;
}
function isYT(url){return url.includes('youtube.com')||url.includes('youtu.be');}
function short(url){return url.replace('https://www.youtube.com/','').replace('https://youtube.com/','');}
function fmtT(d){return new Date(d).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}
function fmtD(d){return new Date(d).toLocaleDateString([],{day:'2-digit',month:'short'});}

async function checkLive(url){
  try{
    const r=await fetch('https://www.youtube.com/oembed?url='+encodeURIComponent(getLiveUrl(url))+'&format=json',{signal:AbortSignal.timeout(12000)});
    return r.ok;
  }catch{return false;}
}

async function notify(title,body){
  try{await Notifications.scheduleNotificationAsync({content:{title,body,sound:true},trigger:null});}catch{}
}

export default function App(){
  const[tab,setTab]=useState('monitoring');
  const[urlInput,setUrlInput]=useState('');
  const[channels,setChannels]=useState([]);
  const[downloads,setDownloads]=useState([]);
  const stopRefs=useRef({});
  const loopRefs=useRef({});
  const dlRef=useRef([]);

  useEffect(()=>{
    Notifications.requestPermissionsAsync();
    load();
  },[]);

  useEffect(()=>{dlRef.current=downloads;},[downloads]);

  async function load(){
    try{
      const ch=await AsyncStorage.getItem(CH_KEY);
      const dl=await AsyncStorage.getItem(DL_KEY);
      if(dl){const p=JSON.parse(dl);setDownloads(p);dlRef.current=p;}
      if(ch)setChannels(JSON.parse(ch).map(c=>({...c,status:'idle',logs:[]})));
    }catch{}
  }

  async function saveCh(list){try{await AsyncStorage.setItem(CH_KEY,JSON.stringify(list));}catch{}}
  async function saveDl(list){try{await AsyncStorage.setItem(DL_KEY,JSON.stringify(list));}catch{}}

  function addChannel(){
    const url=urlInput.trim();
    if(!url)return;
    if(!isYT(url)){Alert.alert('Invalid URL','Please enter a valid YouTube URL.');return;}
    setChannels(prev=>{
      if(prev.find(c=>c.url===url)){Alert.alert('Already added','This channel is already monitored.');return prev;}
      const nc={id:Date.now().toString(),url,liveUrl:getLiveUrl(url),status:'idle',logs:[],addedAt:new Date().toISOString()};
      const upd=[nc,...prev];
      saveCh(upd);
      setTimeout(()=>startMonitor(nc.id,url),100);
      return upd;
    });
    setUrlInput('');
  }

  function log(id,msg,color){
    setChannels(prev=>prev.map(c=>c.id===id?{...c,logs:[...(c.logs||[]).slice(-20),{msg,color:color||C.textMid,time:fmtT(new Date())}]}:c));
  }
  function setSt(id,status){setChannels(prev=>prev.map(c=>c.id===id?{...c,status}:c));}

  async function startMonitor(id,url){
    if(loopRefs.current[id])return;
    stopRefs.current[id]=false;
    loopRefs.current[id]=true;
    activateKeepAwakeAsync();
    setSt(id,'checking');
    log(id,'Monitor started.',C.green);
    while(!stopRefs.current[id]){
      setSt(id,'checking');
      log(id,'Checking live status...',C.textDim);
      const live=await checkLive(url);
      if(stopRefs.current[id])break;
      if(live){
        setSt(id,'live');
        log(id,'LIVE detected!',C.red);
        Vibration.vibrate([0,300,100,300]);
        await notify('Stream is LIVE!',short(getLiveUrl(url))+' is now live!');
        const entry={id:Date.now().toString(),channelUrl:url,liveUrl:getLiveUrl(url),detectedAt:new Date().toISOString(),status:'live'};
        const upd=[entry,...dlRef.current];
        setDownloads(upd);dlRef.current=upd;saveDl(upd);
        setSt(id,'recording');
        log(id,'Recording in progress...',C.red);
        let still=true;
        while(still&&!stopRefs.current[id]){
          await sleepI(POLL,id);
          if(stopRefs.current[id])break;
          log(id,'Checking if still live...',C.textDim);
          still=await checkLive(url);
        }
        if(!stopRefs.current[id]){
          log(id,'Stream ended. Resuming...',C.orange);
          await notify('Stream ended',short(url)+' stream has ended.');
          setDownloads(prev=>{const u=prev.map(d=>d.id===entry.id?{...d,status:'ended',endedAt:new Date().toISOString()}:d);saveDl(u);dlRef.current=u;return u;});
        }
      }else{
        log(id,'Not live. Next check in '+POLL+'s...',C.textDim);
        await sleepI(POLL,id);
      }
    }
    loopRefs.current[id]=false;
    setSt(id,'stopped');
    log(id,'Monitor stopped.',C.textMid);
    if(!Object.values(loopRefs.current).some(Boolean))deactivateKeepAwake();
  }

  function stopMonitor(id){stopRefs.current[id]=true;}
  function restartMonitor(id,url){stopRefs.current[id]=false;startMonitor(id,url);}

  function removeChannel(id){
    Alert.alert('Remove','Stop and remove this channel?',[
      {text:'Cancel',style:'cancel'},
      {text:'Remove',style:'destructive',onPress:()=>{
        stopRefs.current[id]=true;
        setChannels(prev=>{const u=prev.filter(c=>c.id!==id);saveCh(u);return u;});
      }}
    ]);
  }

  async function sleepI(s,id){for(let i=0;i<s;i++){if(stopRefs.current[id])return;await new Promise(r=>setTimeout(r,1000));}}

  const activeCount=channels.filter(c=>['checking','live','recording'].includes(c.status)).length;
  const liveCount=channels.filter(c=>['live','recording'].includes(c.status)).length;

  function Badge({status}){
    const m={idle:{l:'Idle',bg:C.surface2,fg:C.textDim},checking:{l:'Checking',bg:C.greenDark,fg:C.green},live:{l:'LIVE',bg:C.redDark,fg:C.red},recording:{l:'Rec',bg:C.redDark,fg:C.red},stopped:{l:'Stopped',bg:C.surface2,fg:C.textDim}};
    const s=m[status]||m.idle;
    return <View style={[S.badge,{backgroundColor:s.bg}]}><Text style={[S.badgeTxt,{color:s.fg}]}>{s.l}</Text></View>;
  }

  function ChannelCard({item}){
    const running=['checking','live','recording'].includes(item.status);
    const lastLog=(item.logs||[]).slice(-1)[0];
    return(
      <View style={S.card}>
        <View style={S.row}>
          <View style={S.avatar}><Text style={S.avatarTxt}>{short(item.url)[0]?.toUpperCase()||'Y'}</Text></View>
          <View style={{flex:1,gap:4}}>
            <Text style={S.cardUrl} numberOfLines={1}>{short(item.url)}</Text>
            <Badge status={item.status}/>
          </View>
          <View style={{flexDirection:'row',gap:6}}>
            {running
              ?<TouchableOpacity style={S.btnStop} onPress={()=>stopMonitor(item.id)}><Text style={S.btnStopTxt}>Stop</Text></TouchableOpacity>
              :<TouchableOpacity style={S.btnStart} onPress={()=>restartMonitor(item.id,item.url)}><Text style={S.btnStartTxt}>Start</Text></TouchableOpacity>
            }
            <TouchableOpacity onPress={()=>removeChannel(item.id)} style={S.btnX}><Text style={S.btnXTxt}>X</Text></TouchableOpacity>
          </View>
        </View>
        {lastLog&&<Text style={[S.lastLog,{color:lastLog.color}]} numberOfLines={1}>[{lastLog.time}] {lastLog.msg}</Text>}
        {['live','recording'].includes(item.status)&&
          <TouchableOpacity style={S.openBtn} onPress={()=>Linking.openURL(item.liveUrl)}>
            <Text style={S.openBtnTxt}>Open Live Stream</Text>
          </TouchableOpacity>
        }
      </View>
    );
  }

  function DlCard({item}){
    return(
      <TouchableOpacity style={S.dlCard} onPress={()=>Linking.openURL(item.liveUrl)}>
        <View style={[S.avatar,{backgroundColor:item.status==='live'?C.redDark:C.greenDark}]}><Text style={S.avatarTxt}>P</Text></View>
        <View style={{flex:1,gap:3}}>
          <Text style={S.cardUrl} numberOfLines={1}>{short(item.liveUrl)}</Text>
          <Text style={S.metaTxt}>Detected: {fmtD(item.detectedAt)} {fmtT(item.detectedAt)}</Text>
          {item.endedAt&&<Text style={S.metaTxt}>Ended: {fmtT(item.endedAt)}</Text>}
        </View>
        <View style={[S.badge,{backgroundColor:item.status==='live'?C.redDark:C.greenDark}]}>
          <Text style={[S.badgeTxt,{color:item.status==='live'?C.red:C.green}]}>{item.status==='live'?'Live':'Ended'}</Text>
        </View>
      </TouchableOpacity>
    );
  }

  return(
    <SafeAreaView style={S.safe}>
      <StatusBar barStyle="light-content" backgroundColor={C.surface}/>
      <View style={S.header}>
        <Text style={S.headerTitle}>Stream Recorder</Text>
        <View style={{flexDirection:'row',gap:6}}>
          {activeCount>0&&<View style={[S.pill,{backgroundColor:C.greenDark}]}><Text style={[S.pillTxt,{color:C.green}]}>{activeCount} active</Text></View>}
          {liveCount>0&&<View style={[S.pill,{backgroundColor:C.redDark}]}><Text style={[S.pillTxt,{color:C.red}]}>{liveCount} live</Text></View>}
        </View>
      </View>
      <View style={S.tabBar}>
        {['monitoring','downloads'].map(t=>(
          <TouchableOpacity key={t} style={[S.tab,tab===t&&S.tabOn]} onPress={()=>setTab(t)}>
            <Text style={[S.tabTxt,tab===t&&S.tabTxtOn]}>
              {t==='monitoring'?'MONITORING'+(channels.length?' ('+channels.length+')':''):'DOWNLOADS'+(downloads.length?' ('+downloads.length+')':'')}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {tab==='monitoring'&&(
        <View style={{flex:1}}>
          <View style={S.addBar}>
            <TextInput style={S.input} placeholder="Paste YouTube channel URL..." placeholderTextColor={C.textDim} value={urlInput} onChangeText={setUrlInput} autoCapitalize="none" autoCorrect={false} onSubmitEditing={addChannel} returnKeyType="done"/>
            <TouchableOpacity style={S.addBtn} onPress={addChannel}><Text style={S.addBtnTxt}>Add</Text></TouchableOpacity>
          </View>
          {channels.length===0
            ?<View style={S.empty}><Text style={{fontSize:48}}>📡</Text><Text style={S.emptyTitle}>No channels yet</Text><Text style={S.emptyTxt}>Paste a YouTube channel URL above to start monitoring</Text></View>
            :<FlatList data={channels} keyExtractor={i=>i.id} renderItem={({item})=><ChannelCard item={item}/>} contentContainerStyle={{padding:12,gap:10}} showsVerticalScrollIndicator={false}/>
          }
        </View>
      )}
      {tab==='downloads'&&(
        <View style={{flex:1}}>
          <View style={S.dlTopBar}>
            <Text style={S.dlTopTitle}>Stream History</Text>
            {downloads.length>0&&<TouchableOpacity onPress={()=>Alert.alert('Clear All','Remove all history?',[{text:'Cancel',style:'cancel'},{text:'Clear',style:'destructive',onPress:()=>{setDownloads([]);saveDl([]);}}])}><Text style={{color:C.red,fontSize:13}}>Clear All</Text></TouchableOpacity>}
          </View>
          {downloads.length===0
            ?<View style={S.empty}><Text style={{fontSize:48}}>📥</Text><Text style={S.emptyTitle}>No streams recorded</Text><Text style={S.emptyTxt}>Detected streams will appear here</Text></View>
            :<FlatList data={downloads} keyExtractor={i=>i.id} renderItem={({item})=><DlCard item={item}/>} contentContainerStyle={{padding:12,gap:8}} showsVerticalScrollIndicator={false}/>
          }
        </View>
      )}
    </SafeAreaView>
  );
}

const S=StyleSheet.create({
  safe:{flex:1,backgroundColor:C.bg},
  header:{backgroundColor:C.surface,paddingHorizontal:16,paddingVertical:14,flexDirection:'row',alignItems:'center',justifyContent:'space-between'},
  headerTitle:{fontSize:20,fontWeight:'bold',color:C.text},
  pill:{paddingHorizontal:8,paddingVertical:3,borderRadius:12},
  pillTxt:{fontSize:11,fontWeight:'600'},
  tabBar:{flexDirection:'row',backgroundColor:C.surface,borderBottomWidth:1,borderBottomColor:C.border},
  tab:{flex:1,paddingVertical:13,alignItems:'center',borderBottomWidth:2,borderBottomColor:'transparent'},
  tabOn:{borderBottomColor:C.green},
  tabTxt:{fontSize:12,fontWeight:'700',color:C.textMid,letterSpacing:0.5},
  tabTxtOn:{color:C.green},
  addBar:{flexDirection:'row',padding:10,gap:8,backgroundColor:C.surface,borderBottomWidth:1,borderBottomColor:C.border},
  input:{flex:1,backgroundColor:C.surface2,borderRadius:22,paddingHorizontal:14,paddingVertical:10,fontSize:14,color:C.text},
  addBtn:{backgroundColor:C.green,borderRadius:22,paddingHorizontal:16,justifyContent:'center'},
  addBtnTxt:{color:'#fff',fontWeight:'bold',fontSize:14},
  card:{backgroundColor:C.surface,borderRadius:12,padding:12,borderWidth:1,borderColor:C.border},
  row:{flexDirection:'row',alignItems:'center',gap:10},
  avatar:{width:42,height:42,borderRadius:21,backgroundColor:C.greenDark,alignItems:'center',justifyContent:'center'},
  avatarTxt:{fontSize:17,color:C.green,fontWeight:'bold'},
  cardUrl:{fontSize:13,color:C.text,fontWeight:'600'},
  badge:{alignSelf:'flex-start',paddingHorizontal:7,paddingVertical:2,borderRadius:10},
  badgeTxt:{fontSize:10,fontWeight:'bold'},
  btnStop:{backgroundColor:C.redDark,borderRadius:8,paddingHorizontal:10,paddingVertical:5},
  btnStopTxt:{color:C.red,fontWeight:'bold',fontSize:12},
  btnStart:{backgroundColor:C.greenDark,borderRadius:8,paddingHorizontal:10,paddingVertical:5},
  btnStartTxt:{color:C.green,fontWeight:'bold',fontSize:12},
  btnX:{padding:5},
  btnXTxt:{color:C.textDim,fontSize:15},
  lastLog:{fontSize:11,marginTop:8,paddingLeft:52},
  openBtn:{marginTop:10,marginLeft:52,backgroundColor:C.redDark,borderRadius:8,paddingVertical:7,alignItems:'center'},
  openBtnTxt:{color:C.red,fontWeight:'bold',fontSize:12},
  dlTopBar:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',padding:14,borderBottomWidth:1,borderBottomColor:C.border},
  dlTopTitle:{fontSize:14,fontWeight:'bold',color:C.text},
  dlCard:{backgroundColor:C.surface,borderRadius:10,padding:12,flexDirection:'row',alignItems:'center',gap:10,borderWidth:1,borderColor:C.border},
  metaTxt:{fontSize:11,color:C.textDim},
  empty:{flex:1,alignItems:'center',justifyContent:'center',padding:40,gap:12},
  emptyTitle:{fontSize:16,fontWeight:'bold',color:C.text},
  emptyTxt:{fontSize:13,color:C.textDim,textAlign:'center',lineHeight:20},
});
