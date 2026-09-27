const ws=new WebSocket((location.protocol==="https:"?"wss://":"ws://")+location.host);
let myId=null,state=null,me=null,pendingAction=null;
const $=id=>document.getElementById(id);
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.type==="hello")myId=m.id;
if(m.type==="joined"){$("roomBadge").textContent="الغرفة: "+m.code;$("lobbyInfo").innerHTML=`<b>رمز الغرفة: ${m.code}</b><p class="note">أرسل الرمز لباقي اللاعبين.</p>`}
if(m.type==="error")alert(m.message);
if(m.type==="state"){state=m.state;me=m.you;render();}};
function send(x){if(ws.readyState===1)ws.send(JSON.stringify(x));}
function name(){return $("name").value.trim()||"لاعب";}
function create(){send({type:"create",name:name()})}
function join(){send({type:"join",code:$("code").value.trim(),name:name()})}
function start(){send({type:"start"})}
function render(){
 $("lobby").hidden=state.started; $("game").hidden=!state.started;
 $("startBtn").hidden=!(me?.host&&!state.started);
 $("lobbyInfo").innerHTML=state.started?"اللعبة بدأت.":state.players.map(p=>`• ${p.name}`).join("<br>");
 $("message").textContent=state.message||"";
 $("turn").textContent=state.turn===myId?"🎯 دورك":"انتظر دورك";
 $("players").innerHTML=state.players.map(p=>`<div class="player ${p.alive?"":"dead"} ${p.id===state.turn?"active":""}"><div class="pname">${p.name}${p.id===myId?" (أنت)":""}</div><div class="pcoins">🪙 ${p.coins}</div><div class="infs">${p.influences.map(x=>`<span class="dot ${x.revealed?"revealed":""}"></span>`).join("")}</div>${p.alive&&p.id!==myId?`<button class="target" onclick="choose('${p.id}')">اختيار</button>`:""}</div>`).join("");
$("coins").textContent=me?.coins??0;
$("cards").innerHTML=(me?.influences||[]).map(x=>`<div class="cardRole">${x.revealed?`<div class="icon">☠️</div><b>${roleName(x.role)}</b>`:`<div class="icon">🂠</div><b>سري</b>`}</div>`).join("");
renderResponse();
}
function roleName(r){return {duke:"الدوق",assassin:"القاتل",captain:"الكابتن",ambassador:"السفير",contessa:"الكونتيسة"}[r]||r}
function act(a){
 if(state.turn!==myId)return alert("ليس دورك.");
 if(["coup","assassinate","steal"].includes(a)){
   pendingAction=a; $("message").textContent="اختر لاعبًا مستهدفًا من البطاقات أعلاه."; return;
 }
 send({type:"action",action:a});
}
function choose(id){if(pendingAction){send({type:"action",action:pendingAction,target:id});pendingAction=null}}
function renderResponse(){
 const box=$("response"); box.hidden=true; box.innerHTML="";
 if(!state.started)return;
 // Response controls are intentionally offered to every eligible opponent.
 if(state.phase==="challenge" && state.turn===myId){
   box.hidden=false; box.innerHTML=`<b>لم يعترض أحد حتى الآن.</b><br><button class="responseBtn" onclick="send({type:'confirm'})">تأكيد الحركة</button>`;
 } else if(state.phase==="challenge" && state.turn!==myId){
   box.hidden=false; box.innerHTML=`<b>هل تعتقد أن الادعاء كاذب؟</b><br><button class="responseBtn" onclick="send({type:'challenge'})">اعتراض</button>`;
 }
 if(state.phase==="respond" && state.turn===myId){
   box.hidden=false; box.innerHTML=`<b>لم يحجب أحد بعد.</b><br><button class="responseBtn" onclick="send({type:'confirm'})">تأكيد الحركة</button>`;
 } else if(state.phase==="respond" && state.turn!==myId){
   box.hidden=false; box.innerHTML=`<b>هل تريد الحجب؟</b><br><button class="responseBtn" onclick="send({type:'block',role:'duke'})">دوق — حجب المساعدات</button><button class="responseBtn" onclick="send({type:'block',role:'contessa'})">كونتيسة — حجب الاغتيال</button><button class="responseBtn" onclick="send({type:'block',role:'captain'})">كابتن — حجب السرقة</button><button class="responseBtn" onclick="send({type:'block',role:'ambassador'})">سفير — حجب السرقة</button>`;
 }
 if(state.phase==="reveal"){
   const target=state.players.find(p=>p.id===myId);
   if(target && target.alive && state.turn===myId){
     box.hidden=false;box.innerHTML=`<b>اختر النفوذ الذي ستكشفه:</b><br>${(me.influences||[]).map((x,i)=>x.revealed?"":`<button class="responseBtn" onclick="send({type:'reveal',index:${i}})">${i+1}</button>`).join("")}`;
   }
 }
}
