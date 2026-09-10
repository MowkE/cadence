import { initScrollExamples } from './scroll-examples.js';
import { initParkour } from './game.js';
const $ = id => document.getElementById(id);
const clamp = (n, min=0, max=1) => Math.max(min, Math.min(max,n));
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const narrowQuery = matchMedia('(max-width: 760px)');
let manualMotionOff = false;
try { manualMotionOff = localStorage.getItem('cadence.site.motion') === 'off'; } catch {}
const motionEvents = new EventTarget();
const motion = { get matches(){ return motionQuery.matches || manualMotionOff; }, addEventListener(...a){motionEvents.addEventListener(...a);},removeEventListener(...a){motionEvents.removeEventListener(...a);} };
let heroSculpture, labSculpture, labPaused=false, gameOpen=false, scrollFrame=0, activeStep=-1, activeWorld=0, isAudioOn=false;
const story = $('experience'), stage=document.querySelector('.desktop-stage'), storyButtons=[...document.querySelectorAll('[data-step]')];
const descriptions = ['The right words, right where you are. Cadence floats over your desktop while the rest of your day keeps moving.','Just the line you need. A tiny notch of music at the top of your screen, leaving your desktop open for everything else.','Let the room fall away. Album colors, living lyrics, and a little space to get lost in your favorite song.'];
const captions=['FLOATING LYRICS / FULL VIEW','NOTCH VIEW / ROOM TO THINK','ALBUM COLORS / IN THE MOMENT'];
function setStep(step) {
  if(activeStep===step)return;
  activeStep=step; stage.dataset.scene=String(step);
  document.querySelector('.story-description').textContent=descriptions[step];
  document.querySelector('.stage-caption').textContent=captions[step];
  storyButtons.forEach((b,i)=>{b.classList.toggle('active',i===step);b.setAttribute('aria-pressed',String(i===step));});
}
setStep(0);
storyButtons.forEach((b,i)=>b.addEventListener('click',()=>{
  if(narrowQuery.matches||innerHeight<760||motion.matches){setStep(i);return;}
  const start=story.getBoundingClientRect().top+scrollY;
  window.scrollTo({top:start+(story.offsetHeight-innerHeight)*(i+.18)/3,behavior:motion.matches?'instant':'smooth'});
}));
function updateScroll() {
  scrollFrame=0;
  const y=scrollY, h=innerHeight;
  $('parkour-launch').classList.toggle('is-floating',y>h*.8);
  const total=Math.max(1,document.documentElement.scrollHeight-h);
  document.querySelector('.scroll-meter').style.transform=`scaleX(${clamp(y/total)})`;
  const rect=story.getBoundingClientRect();
  const progress=clamp(-rect.top/Math.max(1,story.offsetHeight-h));
  if(!narrowQuery.matches&&innerHeight>=760&&!motion.matches) {
    setStep(Math.min(2,Math.floor(progress*3)));
    story.style.setProperty('--story-progress',String(progress));
  }
  if(!motion.matches){
    const hero=document.querySelector('.hero').getBoundingClientRect();
    if(hero.bottom>0)heroSculpture?.setProgress(clamp(-hero.top/h)*.7);
    const world=document.querySelector('.world-stage').getBoundingClientRect();
    if(world.bottom>0&&world.top<h)document.documentElement.style.setProperty('--world-parallax',`${clamp((h*.5-world.top)/h,-1,1)*20}px`);
    const lab=$('sculpture').getBoundingClientRect();
    if(lab.bottom>0&&lab.top<h)labSculpture?.setProgress(clamp((h*.5-lab.top)/h)*.7);
  }
}
function queueScroll(){if(!scrollFrame)scrollFrame=requestAnimationFrame(updateScroll);}
addEventListener('scroll',queueScroll,{passive:true});addEventListener('resize',queueScroll,{passive:true});
function syncMotion(){
  document.body.classList.toggle('motion-off',motion.matches);
  document.documentElement.style.scrollBehavior=motion.matches?'auto':'';
  $('motion-toggle').textContent=motion.matches?'Motion: off':'Motion: on';
  $('motion-toggle').setAttribute('aria-pressed',String(motion.matches));
  motionEvents.dispatchEvent(new Event('change'));
  if(motion.matches){heroSculpture?.setProgress(0);labSculpture?.setProgress(0);}
  queueScroll();
}
$('motion-toggle').addEventListener('click',()=>{
  if(motionQuery.matches){$('motion-toggle').textContent='Reduced motion follows your device';return;}
  manualMotionOff=!manualMotionOff;
  try{localStorage.setItem('cadence.site.motion',manualMotionOff?'off':'on');}catch{}
  syncMotion();
});
motionQuery.addEventListener('change',syncMotion);narrowQuery.addEventListener('change',queueScroll);syncMotion();
const reveals=[...document.querySelectorAll('.remix-heading,.together-copy,.details-section>h2,.details-grid article,.together-bottom>div,.download-main')];
if('IntersectionObserver' in window){
  document.body.classList.add('motion-ready');
  const revealObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('visible');revealObserver.unobserve(entry.target);}}),{threshold:.08});
  reveals.forEach(el=>{el.classList.add('reveal');revealObserver.observe(el);});
}
const worlds=[
 {id:'moonlake',alt:'An illustrated moonlit lake surrounded by mountains',description:'For the songs that feel like staying up.'},
 {id:'train',alt:'A warm illustrated train carriage looking out into the rain',description:'For the songs that take the long way home.'},
 {id:'meadow',alt:'An illustrated sunlit meadow beneath an open sky',description:'For the songs that make the whole day softer.'},
 {id:'neon',alt:'An illustrated city glowing with neon after dark',description:'For the songs that keep the city awake.'},
 {id:'sea',alt:'An illustrated turquoise coastline with wildflowers and a cottage above the sea',description:'For the songs that taste like salt in the air.'},
 {id:'lantern',alt:'A riverside village glowing with lanterns beneath a blue evening sky',description:'For the songs that bring a little light home.'},
 {id:'snow',alt:'A warm wooden cabin beside a snow-covered forest at sunset',description:'For the songs that make the world stand still.'},
 {id:'observatory',alt:'A mountain observatory under the Milky Way and a sky full of stars',description:'For the songs that feel bigger than the sky.'}
];
const worldButtons=[...document.querySelectorAll('.world-selector [data-world]')];
let worldRequest=0;
async function chooseWorld(index){
  activeWorld=index;const request=++worldRequest,w=worlds[index],image=$('world-image');
  worldButtons.forEach((b,i)=>b.setAttribute('aria-pressed',String(i===index)));
  const next=new Image();next.src=`./media/${w.id}.webp`;
  try{await next.decode();}catch{return;}
  if(request!==worldRequest)return;
  image.src=next.src;image.alt=w.alt;
  document.querySelector('.world-stage').dataset.world=w.id;
  document.querySelector('.world-number').textContent=String(index+1).padStart(2,'0');
  $('world-description').textContent=w.description;
  if(!motion.matches)image.animate([{opacity:.3,filter:'blur(6px)'},{opacity:1,filter:'blur(0)'}],{duration:600,easing:'ease-out'});
}
worldButtons.forEach((b,i)=>b.addEventListener('click',()=>examples.selectWorld(i)));
$('shuffle-world').addEventListener('click',()=>examples.selectWorld((activeWorld+1+Math.floor(Math.random()*(worlds.length-1)))%worlds.length));
const formButtons=[...document.querySelectorAll('[data-form]')];
formButtons.forEach((b,i)=>b.addEventListener('click',()=>{
  formButtons.forEach(el=>el.setAttribute('aria-pressed',String(el===b)));
  $('form-number').textContent=String(i+1).padStart(3,'0');
  labSculpture?.setMode(b.dataset.form);
}));
$('energy').addEventListener('input',()=>{$('energy-value').value=$('energy').value+'%';labSculpture?.setEnergy(Number($('energy').value)/100);});
$('reset-sculpture').addEventListener('click',()=>labSculpture?.reset());
$('pause-sculpture').addEventListener('click',()=>{
  labPaused=!labPaused;labSculpture?.setPaused(labPaused);
  $('pause-sculpture').textContent=labPaused?'▶':'Ⅱ';
  $('pause-sculpture').setAttribute('aria-label',labPaused?'Resume sculpture animation':'Pause sculpture animation');
  $('pause-sculpture').setAttribute('aria-pressed',String(labPaused));
});
// Demo data is deliberately local. Nothing here messages an account or a friend.
const socialButtons=[...document.querySelectorAll('[data-social]')];
function chooseSocial(key){
  socialButtons.forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.social===key)));
  document.querySelectorAll('[data-social-view]').forEach(view=>{view.hidden=view.dataset.socialView!==key;});
}
const examples=initScrollExamples({motion,onWorld:chooseWorld,onSocial:chooseSocial});
socialButtons.forEach(b=>b.addEventListener('click',()=>examples.selectSocial(b.dataset.social)));
document.querySelectorAll('.reaction-row button').forEach(b=>{
  b.setAttribute('aria-pressed','false');
  b.addEventListener('click',()=>{
    document.querySelectorAll('.reaction-row button').forEach(el=>el.setAttribute('aria-pressed',String(el===b)));
    $('reaction-status').textContent=`${b.textContent} ADDED TO THIS PREVIEW`;
    if(!motion.matches)b.animate([{transform:'scale(1)'},{transform:'scale(1.25)'},{transform:'scale(1)'}],{duration:300});
  });
});
$('demo-chat').addEventListener('submit',event=>{
  event.preventDefault();const value=$('chat-message').value.trim();if(!value)return;
  const message=document.querySelector('.chat-bubble.outgoing');message.textContent=value;
  $('chat-message').value='';$('demo-message-status').textContent='Message added to this local preview. Nothing was sent.';
  if(!motion.matches)message.animate([{opacity:.3,transform:'translateY(8px)'},{opacity:1,transform:'none'}],{duration:250});
});
const assets={'mac-arm64':'Cadence-mac-arm64.dmg','mac-x64':'Cadence-mac-x64.dmg','win-x64':'Cadence-win-x64-Setup.exe','linux-x86_64':'Cadence-linux-x86_64.AppImage'};
function updateDownload(){$('download-link').href='https://github.com/MowkE/cadence/releases/latest/download/'+assets[$('platform').value];}
// Architecture cannot be reliably inferred for every Mac; the explicit selector stays visible.
if(/Windows/i.test(navigator.userAgent))$('platform').value='win-x64';
else if(/Linux/i.test(navigator.userAgent)&&!/Android/i.test(navigator.userAgent))$('platform').value='linux-x86_64';
$('platform').addEventListener('change',updateDownload);updateDownload();
// An original, quiet ambient chord loop. Audio starts only from a user gesture.
let audioContext, master, audioTimer, chord=0, audioBusy=false;
const chords=[[146.83,220,293.66,369.99],[130.81,196,261.63,329.63],[164.81,246.94,329.63,392],[110,164.81,220,293.66]];
function scheduleChord(){
  if(!isAudioOn||!audioContext)return;
  const start=audioContext.currentTime;
  chords[chord++%chords.length].forEach((freq,i)=>{
    const oscillator=audioContext.createOscillator(),gain=audioContext.createGain();oscillator.type='sine';oscillator.frequency.value=freq;oscillator.detune.value=i%2?3:-3;
    gain.gain.setValueAtTime(0,start);gain.gain.linearRampToValueAtTime(.055/(1+i*.3),start+1.5);gain.gain.exponentialRampToValueAtTime(.0001,start+6.4);
    oscillator.connect(gain);gain.connect(master);oscillator.start(start);oscillator.stop(start+6.5);oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};
  });
  audioTimer=setTimeout(scheduleChord,5000);
}
function paintAudio(){document.body.classList.toggle('audio-on',isAudioOn);$('sound-toggle').textContent=isAudioOn?'Ⅱ':'▶';$('sound-toggle').setAttribute('aria-pressed',String(isAudioOn));$('sound-toggle').setAttribute('aria-label',isAudioOn?'Pause original ambient demo':'Play original ambient demo');}
async function stopAudio(){isAudioOn=false;clearTimeout(audioTimer);paintAudio();if(master)master.gain.setTargetAtTime(0,audioContext.currentTime,.08);if(audioContext)await audioContext.suspend();}
$('sound-toggle').addEventListener('click',async()=>{
  if(audioBusy)return;audioBusy=true;
  try{
    if(isAudioOn){await stopAudio();return;}
    const AudioCtor=window.AudioContext||window.webkitAudioContext;
    if(!AudioCtor){$('sound-toggle').setAttribute('aria-label','Audio preview unavailable in this browser');return;}
    audioContext ||= new AudioCtor();
    if(!master){master=audioContext.createGain();master.gain.value=.38;master.connect(audioContext.destination);}
    await audioContext.resume();if(document.hidden||gameOpen){await audioContext.suspend();return;}master.gain.setTargetAtTime(.38,audioContext.currentTime,.1);isAudioOn=true;paintAudio();scheduleChord();
  }catch{$('sound-toggle').setAttribute('aria-label','Audio could not start. Try again.');}finally{audioBusy=false;}
});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&isAudioOn)stopAudio();else if(!document.hidden)queueScroll();});
addEventListener('pagehide',()=>{clearTimeout(audioTimer);if(audioContext)audioContext.suspend();});
// Lazy-load local Three.js so the readable page and every ordinary control are independent of WebGL.
async function mountSculptures(){
  try{
    const {initSculpture}=await import('./scene.js');
    heroSculpture=initSculpture({canvas:$('hero-canvas'),reducedMotion:motion,onReady:ready=>{document.querySelector('.hero-art').classList.toggle('webgl-ready',ready);$('hero-canvas').tabIndex=ready?0:-1;}});
    heroSculpture.setEnergy(.22);heroSculpture.setPaused(gameOpen);
    const mountLab=()=>{
      if(labSculpture)return;
      labSculpture=initSculpture({canvas:$('lab-canvas'),reducedMotion:motion,onReady:ready=>{
        document.querySelector('.sculpture-object').classList.toggle('webgl-ready',ready);
        $('lab-canvas').tabIndex=ready?0:-1;
        $('sculpture-hint').textContent=ready?'DRAG TO EXPLORE · ARROW KEYS TO ROTATE':'STATIC EDITION / 3D IS UNAVAILABLE IN THIS BROWSER';
        [...formButtons,$('energy'),$('pause-sculpture'),$('reset-sculpture')].forEach(el=>el.disabled=!ready);
      }});
      labSculpture.setEnergy(Number($('energy').value)/100);labSculpture.setMode(formButtons.find(b=>b.getAttribute('aria-pressed')==='true').dataset.form);labSculpture.setPaused(gameOpen||labPaused);queueScroll();
    };
    const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){mountLab();observer.disconnect();}},{rootMargin:'400px'});observer.observe($('sculpture'));queueScroll();
  }catch{
    $('hero-canvas').tabIndex=-1;$('lab-canvas').tabIndex=-1;
    $('sculpture-hint').textContent='STATIC EDITION / 3D IS UNAVAILABLE IN THIS BROWSER';
    [...formButtons,$('energy'),$('pause-sculpture'),$('reset-sculpture')].forEach(el=>el.disabled=true);
  }
}
mountSculptures();queueScroll();

const parkour=initParkour({trigger:$('parkour-launch'),onOpen(){gameOpen=true;heroSculpture?.setPaused(true);labSculpture?.setPaused(true);if(isAudioOn)stopAudio();},onClose(){gameOpen=false;heroSculpture?.setPaused(false);labSculpture?.setPaused(labPaused);examples.refresh();queueScroll();}});
