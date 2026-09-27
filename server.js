const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const { WebSocketServer } = require("ws");

const app = express();
app.use(express.static(__dirname));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map();
const roles = ["duke","assassin","captain","ambassador","contessa"];
const roleNames = {
  duke:"الدوق", assassin:"القاتل", captain:"الكابتن",
  ambassador:"السفير", contessa:"الكونتيسة"
};

function roomCode() {
  let c;
  do c = Math.random().toString(36).slice(2,7).toUpperCase(); while(rooms.has(c));
  return c;
}
function makeDeck(n=3) {
  const d=[]; for(const r of roles) for(let i=0;i<n;i++) d.push(r);
  return d.sort(()=>Math.random()-0.5);
}
function draw(room){ return room.deck.pop(); }
function alive(p){ return p.influences.some(x=>!x.revealed); }
function pub(room) {
  return {
    code: room.code, started: room.started, turn: room.turn,
    phase: room.phase, message: room.message,
    players: room.players.map(p=>({
      id:p.id,name:p.name,coins:p.coins,alive:alive(p),
      influences:p.influences.map(x=>({revealed:x.revealed, role:x.revealed?x.role:null}))
    }))
  };
}
function send(ws,obj){ if(ws.readyState===1) ws.send(JSON.stringify(obj)); }
function broadcast(room) {
  for(const p of room.players) send(p.ws,{type:"state",state:pub(room),you:{
    id:p.id,influences:p.influences,host:p.id===room.host
  }});
}
function err(ws,msg){send(ws,{type:"error",message:msg});}
function nextAlive(room) {
  for(let i=1;i<=room.players.length;i++){
    const idx=(room.turnIndex+i)%room.players.length;
    if(alive(room.players[idx])) return idx;
  }
  return room.turnIndex;
}
function startTurn(room){
  room.turnIndex = room.turnIndex % room.players.length;
  while(!alive(room.players[room.turnIndex])) room.turnIndex=(room.turnIndex+1)%room.players.length;
  room.turn=room.players[room.turnIndex].id;
  room.phase="choose"; room.pending=null;
  room.message=`دور ${room.players[room.turnIndex].name}`;
}
function reveal(p, index){
  const hidden=p.influences.filter((x,i)=>!x.revealed).map((x,i)=>p.influences.indexOf(x));
  if(index==null || !p.influences[index] || p.influences[index].revealed) index=hidden[0];
  p.influences[index].revealed=true;
}
function getP(room,id){return room.players.find(p=>p.id===id);}
function targetOk(room,id){const p=getP(room,id); return p && alive(p);}
function finishIf(room){
  const living=room.players.filter(alive);
  if(living.length===1){room.phase="finished"; room.message=`🏆 الفائز: ${living[0].name}`; return true;}
  return false;
}
function reset(room){
  room.deck=makeDeck(3); room.started=true; room.phase="choose"; room.turnIndex=0;
  for(const p of room.players){
    p.coins=2; p.influences=[{role:draw(room.deck?room:null),revealed:false},{role:null,revealed:false}];
  }
  // repair draw calls without a room-aware helper
  for(const p of room.players) p.influences[0].role = room.deck.pop();
  for(const p of room.players) p.influences[1].role = room.deck.pop();
  startTurn(room);
}
function deal(room){
  room.deck=makeDeck(3);
  for(const p of room.players){
    p.coins=2;
    p.influences=[{role:room.deck.pop(),revealed:false},{role:room.deck.pop(),revealed:false}];
  }
}
function begin(room){
  room.deck=makeDeck(3);
  room.players.forEach(p=>{p.coins=2;p.influences=[{role:room.deck.pop(),revealed:false},{role:room.deck.pop(),revealed:false}];});
  room.started=true; room.phase="choose"; room.turnIndex=0; startTurn(room);
}
function endAction(room){ if(!finishIf(room)){room.turnIndex=nextAlive(room); startTurn(room);} broadcast(room); }

function action(room,p,a,target){
  if(room.phase!=="choose" || room.turn!==p.id) return err(p.ws,"ليس دورك.");
  if(p.coins>=10 && a!=="coup") return err(p.ws,"لديك 10 عملات أو أكثر، يجب تنفيذ انقلاب.");
  if(a==="income"){p.coins++; room.message=`${p.name} أخذ دخلًا قدره 1.`; return endAction(room);}
  if(a==="foreign"){ room.pending={type:"foreign",actor:p.id}; room.phase="respond"; room.message=`${p.name} طلب مساعدات خارجية (+2). يمكن للدوق الاعتراض.`; return broadcast(room);}
  if(a==="coup"){
    if(p.coins<7) return err(p.ws,"تحتاج 7 عملات.");
    if(!targetOk(room,target)||target===p.id) return err(p.ws,"اختر لاعبًا صالحًا.");
    p.coins-=7; room.pending={type:"coup",actor:p.id,target}; room.phase="reveal";
    room.message=`${p.name} نفّذ انقلابًا ضد ${getP(room,target).name}.`; return broadcast(room);
  }
  const req={tax:"duke",assassinate:"assassin",steal:"captain",exchange:"ambassador"}[a];
  if(!req) return err(p.ws,"حركة غير معروفة.");
  if(a==="assassinate" && p.coins<3) return err(p.ws,"تحتاج 3 عملات.");
  if((a==="assassinate"||a==="steal") && (!targetOk(room,target)||target===p.id)) return err(p.ws,"اختر لاعبًا صالحًا.");
  if(a==="steal" && getP(room,target).coins<1) return err(p.ws,"هذا اللاعب لا يملك عملات.");
  room.pending={type:a,actor:p.id,target,claim:req}; room.phase="challenge";
  room.message=`${p.name} يدّعي امتلاك ${roleNames[req]}. يمكن للاعبين الاعتراض.`; broadcast(room);
}

function challenge(room,challenger){
  const q=room.pending, actor=getP(room,q.actor);
  if(!q || !actor || !alive(challenger) || challenger.id===actor.id) return err(challenger.ws,"لا يمكنك الاعتراض الآن.");
  const has=actor.influences.some(x=>!x.revealed && x.role===q.claim);
  if(has){
    // challenger loses influence
    reveal(challenger, challenger.influences.findIndex(x=>!x.revealed));
    // claimed card is revealed, returned, then actor draws replacement
    const idx=actor.influences.findIndex(x=>!x.revealed && x.role===q.claim);
    actor.influences[idx].role=room.deck.pop();
    room.message=`اعتراض غير صحيح: ${challenger.name} خسر نفوذًا.`;
    if(finishIf(room)){broadcast(room);return;}
    resolve(room);
  } else {
    reveal(actor, actor.influences.findIndex(x=>!x.revealed));
    room.message=`اعتراض صحيح: ${actor.name} خسر نفوذًا ولم تُنفذ الحركة.`;
    if(finishIf(room)){broadcast(room);return;}
    endAction(room);
  }
}
function block(room, blocker, role){
  const q=room.pending;
  if(!q || room.phase!=="respond") return err(blocker.ws,"لا يوجد طلب يمكن حجبه.");
  const valid=(q.type==="foreign"&&role==="duke") ||
    (q.type==="assassinate"&&role==="contessa") ||
    (q.type==="steal"&&(role==="captain"||role==="ambassador"));
  if(!valid) return err(blocker.ws,"هذه البطاقة لا تحجب هذه الحركة.");
  if(blocker.id===q.actor) return err(blocker.ws,"لا يمكنك حجب نفسك.");
  q.block={player:blocker.id,role}; q.claim=role; room.phase="challenge";
  room.message=`${blocker.name} يحجب الحركة مدعيًا ${roleNames[role]}. يمكن الاعتراض على الحجب.`; broadcast(room);
}
function challengeBlock(room, challenger){
  const q=room.pending, b=getP(room,q.block.player);
  if(!q||!b||challenger.id===b.id) return err(challenger.ws,"لا يمكن الاعتراض.");
  const has=b.influences.some(x=>!x.revealed&&x.role===q.block.role);
  if(has){
    reveal(challenger,challenger.influences.findIndex(x=>!x.revealed));
    const idx=b.influences.findIndex(x=>!x.revealed&&x.role===q.block.role);
    b.influences[idx].role=room.deck.pop();
    room.message=`الحجب صحيح؛ ${challenger.name} خسر نفوذًا.`;
    if(finishIf(room)){broadcast(room);return;}
    // successful block stops action
    endAction(room);
  } else {
    reveal(b,b.influences.findIndex(x=>!x.revealed));
    room.message=`الحجب كاذب؛ ${b.name} خسر نفوذًا.`;
    if(finishIf(room)){broadcast(room);return;}
    q.block=null; q.claim=null;
    resolve(room);
  }
}
function resolve(room){
  const q=room.pending, actor=getP(room,q.actor);
  if(!q) return;
  if(q.block){ endAction(room); return; }
  if(q.type==="tax"){actor.coins+=3;room.message=`${actor.name} أخذ 3 عملات بالضريبة.`;}
  if(q.type==="assassinate"){actor.coins-=3;const t=getP(room,q.target);reveal(t,t.influences.findIndex(x=>!x.revealed));room.message=`${actor.name} نفّذ اغتيالًا ضد ${t.name}.`; }
  if(q.type==="steal"){const t=getP(room,q.target);const n=Math.min(2,t.coins);t.coins-=n;actor.coins+=n;room.message=`${actor.name} سرق ${n} عملة من ${t.name}.`;}
  if(q.type==="exchange"){
    const drawn=[room.deck.pop(),room.deck.pop()];
    const hidden=actor.influences.filter(x=>!x.revealed).map(x=>x.role);
    const pool=[...hidden,...drawn].sort(()=>Math.random()-0.5);
    // server chooses randomly for now; UI can be extended to let player choose
    const keep=pool.slice(0,hidden.length);
    actor.influences.forEach((x,i)=>{if(!x.revealed)x.role=keep.shift();});
    room.deck.push(...pool.slice(hidden.length),...hidden);
    room.deck.sort(()=>Math.random()-0.5);
    room.message=`${actor.name} بدّل نفوذه.`; 
  }
  if(finishIf(room)){broadcast(room);return;}
  endAction(room);
}

wss.on("connection", ws=>{
  const id=crypto.randomUUID(); ws.id=id;
  send(ws,{type:"hello",id});
  ws.on("message",raw=>{
    let m; try{m=JSON.parse(raw)}catch{return}
    if(m.type==="create"){
      const code=roomCode(), room={code,host:id,players:[],started:false,phase:"lobby",message:"بانتظار اللاعبين"};
      rooms.set(code,room); room.players.push({id,name:String(m.name||"لاعب").slice(0,18),coins:0,influences:[],ws});
      ws.room=code; send(ws,{type:"joined",code}); broadcast(room); return;
    }
    const room=rooms.get(ws.room||String(m.code||"").toUpperCase());
    if(m.type==="join"){
      if(!room) return err(ws,"الغرفة غير موجودة.");
      if(room.started||room.players.length>=6) return err(ws,"لا يمكن الانضمام لهذه الغرفة.");
      const p={id,name:String(m.name||"لاعب").slice(0,18),coins:0,influences:[],ws};
      room.players.push(p);ws.room=room.code;send(ws,{type:"joined",code:room.code});broadcast(room);return;
    }
    if(!room) return;
    const p=room.players.find(x=>x.id===id);
    if(m.type==="start"){
      if(id!==room.host) return err(ws,"المضيف فقط يستطيع البدء.");
      if(room.players.length<3) return err(ws,"تحتاج 3 لاعبين على الأقل.");
      begin(room); broadcast(room); return;
    }
    if(m.type==="action"){action(room,p,m.action,m.target);return;}
    if(m.type==="confirm"){
      if(room.pending && room.pending.actor===p.id && (room.phase==="challenge" || room.phase==="respond")){
        if(room.phase==="respond" && room.pending.type==="foreign"){ p.coins+=2; room.message=`${p.name} حصل على مساعدات خارجية +2.`; endAction(room); return; }
        room.phase="resolve"; resolve(room);
      } else err(ws,"لا يمكنك التأكيد الآن.");
      return;
    }
    if(m.type==="challenge"){
      if(room.phase==="challenge" && room.pending && room.pending.block) challengeBlock(room,p);
      else challenge(room,p);
      return;
    }
    if(m.type==="block"){block(room,p,m.role);return;}
    if(m.type==="reveal"){
      if(room.phase!=="reveal"||!room.pending) return;
      const t=getP(room,room.pending.target);
      if(!t||p.id!==t.id) return err(ws,"ليس دورك لاختيار النفوذ.");
      reveal(t,Number(m.index)); endAction(room); return;
    }
  });
  ws.on("close",()=>{
    const room=rooms.get(ws.room); if(!room)return;
    const idx=room.players.findIndex(p=>p.id===id); if(idx>=0) room.players.splice(idx,1);
    if(room.players.length===0){rooms.delete(room.code);return;}
    if(room.host===id) room.host=room.players[0].id;
    if(room.started && !finishIf(room)) {
      if(room.turnIndex>=room.players.length) room.turnIndex=0;
      if(room.players[room.turnIndex] && room.players[room.turnIndex].id===id) startTurn(room);
    }
    broadcast(room);
  });
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Coup Arabic running on http://localhost:${PORT}`));
