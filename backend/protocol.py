import base64
import hashlib
import math
import struct
from datetime import datetime, timezone

RAW_V2 = [68,67,64,63,62,61,59,58,57,56,55,54,53,52,51,50,49,48,47,46,45,44,43,42,41,40,39,38,37,36,34,33,32,31,29,28,27,26,24,23,22,21,19,18,17,16,14,13,12,11,9,8,7,6,2,1]
RAW_V1 = [67,68,61,62,63,64,55,56,57,58,59,50,51,52,53,54,45,46,47,48,49,40,41,42,43,44,36,37,38,39,31,32,33,34,26,27,28,29,21,22,23,24,16,17,18,19,11,12,13,14,6,7,8,9,1,2]
WT_LENGTHS = {**{i:11 for i in range(0x50,0x57)},0x57:20,0x58:20,0x59:20,0x5a:11,0x5f:11,0x61:20,0x71:20}
WT_HEADER = ['时间','设备名称','加速度X(g)','加速度Y(g)','加速度Z(g)','角速度X(°/s)','角速度Y(°/s)','角速度Z(°/s)','角度X(°)','角度Y(°)','角度Z(°)','磁场X(uT)','磁场Y(uT)','磁场Z(uT)','四元数0()','四元数1()','四元数2()','四元数3()','温度(°C)','高度(m)','气压(kPa)','版本号()','电量(%)']


def crc_ccitt(data):
    crc = 0xffff
    for x in data:
        crc ^= x << 8
        for _ in range(8):
            crc = ((crc << 1) ^ (0x1021 if crc & 0x8000 else 0)) & 0xffff
    return crc


def crc_measurement(frame):
    body = frame[:-2][:138].ljust(138, b'\0')
    return crc_ccitt(body) == int.from_bytes(frame[-2:], 'little')


def device_clock(date, clock):
    try:
        year = date // 10000
        if not 2000 <= year <= 2099:
            return None
        d = datetime(year, date//100 % 100, date % 100, clock//10000000,
                     clock//100000 % 100, clock//1000 % 100, clock % 1000*1000, tzinfo=timezone.utc)
        return d.timestamp()*1000
    except (ValueError, OverflowError):
        return None


def slot_map(foot, topology='v2'):
    base = RAW_V1 if topology == 'v1' else RAW_V2
    return [x//5*5+4-x%5 if foot == 'r' and topology != 'v1' else x for x in base]


class Decoder:
    def __init__(self, profile):
        self.profile = profile
        self.pending = b''
        self.bad = 0
        self.ignored = 0
        self.last_clock = None
        self.repeats = 0
        self.slots = [0]*70
        self.extra = {}

    def feed(self, data):
        if isinstance(data, str):
            data = base64.b64decode(data, validate=True)
        if len(data) > 8192:
            raise ValueError('notification exceeds 8192 bytes')
        data = self.pending + bytes(data)
        out = []
        i = 0
        while i < len(data):
            if self.profile == 'insole':
                if data[i] != 0x5a:
                    i += 1
                    continue
                if len(data)-i < 3:
                    break
                if data[i+1:i+3] != b'\x00\x09':
                    i += 1
                    continue
                if len(data)-i < 30:
                    break
                count = data[i+29]
                if count > 70:
                    self.bad += 1
                    i += 1
                    continue
                n = 46+2*count
                if len(data)-i < n:
                    break
                frame = data[i:i+n]
                if not crc_measurement(frame):
                    self.bad += 1
                    i += 1
                    continue
                if sum((x & 31).bit_count() for x in frame[30:44]) != count or any(x & 224 for x in frame[30:44]):
                    self.bad += 1
                    i += n
                    continue
                seq, clock, date = struct.unpack_from('<III', frame, 3)
                raw = list(struct.unpack_from('<6h', frame, 17))
                own = [raw[1]/2048,-raw[0]/2048,raw[2]/2048,raw[4]*.07,-raw[3]*.07,raw[5]*.07]
                stamp = device_clock(date, clock)
                self.repeats = self.repeats+1 if stamp == self.last_clock else 0
                self.last_clock = stamp
                sparse = [0]*70
                observed = []
                k = 0
                for row in range(14):
                    for col in range(5):
                        if frame[30+row] & (1 << col):
                            slot = (13-row)*5+col
                            value = struct.unpack_from('<h', frame, 44+2*k)[0]
                            sparse[slot] = self.slots[slot] = value
                            observed.append(slot)
                            k += 1
                out.append(dict(raw6=raw,values=own,seq=seq,device_ms=stamp,device_date=date,device_time=clock,
                                clock_coarse=self.repeats >= 3,temperature=struct.unpack_from('<h',frame,15)[0]/100,
                                pressure_sparse=sparse,pressure_slots=list(self.slots),pressure_observed_slots=observed,
                                raw_frame_hex=frame.hex(),raw_packet_sha256=hashlib.sha256(frame).hexdigest(),kind=9))
            else:
                if data[i] != 0x55:
                    i += 1
                    continue
                if len(data)-i < 2:
                    break
                kind = data[i+1]
                n = WT_LENGTHS.get(kind)
                if not n:
                    i += 1
                    continue
                if len(data)-i < n:
                    break
                frame = data[i:i+n]
                short = n == 11
                if short and sum(frame[:10]) % 256 != frame[10]:
                    self.bad += 1
                    i += 1
                    continue
                raw = list(struct.unpack_from('<3h',frame,2))
                values = None
                if kind == 0x61:
                    raw = list(struct.unpack_from('<9h',frame,2))
                    values = [x/2048 for x in raw[:3]]+[x*2000/32768 for x in raw[3:6]]
                    self.extra['angles'] = [x*180/32768 for x in raw[6:9]]
                elif kind in (0x51,0x52,0x53,0x54):
                    key, scale = {0x51:('acc',1/2048),0x52:('gyro',2000/32768),0x53:('angles',180/32768),0x54:('mag',8000/32768)}[kind]
                    self.extra[key] = [x*scale for x in raw]
                    self.extra['temperature'] = struct.unpack_from('<h',frame,8)[0]/100
                    if kind in (0x51,0x52):
                        values = self.extra.get('acc',[None]*3)+self.extra.get('gyro',[None]*3)
                elif kind == 0x59:
                    self.extra['quaternion'] = [x/32768 for x in struct.unpack_from('<4h',frame,2)]
                else:
                    self.ignored += 1
                out.append(dict(raw6=raw[:6] if kind == 0x61 else [],values=values,kind=kind,
                                inference_eligible=kind == 0x61,raw_frame_hex=frame.hex(),
                                raw_packet_sha256=hashlib.sha256(frame).hexdigest(),**self.extra))
            i += n
        self.pending = data[i:]
        if len(self.pending) > 8192:
            self.pending = b''
            self.bad += 1
        return out


def command_packet(kind, payload=b'', sequence=1, wall_ms=0, link='v2'):
    if link not in ('v1','v2') or len(payload) > 60:
        raise ValueError('invalid command')
    packet = bytearray(144 if link == 'v2' else 80)
    struct.pack_into('<BBIII',packet,0,0x5a,kind,sequence & 0xffffffff,int(wall_ms) & 0xffffffff,len(payload))
    packet[14:14+len(payload)] = payload
    crc = 0xffff
    for value in packet[:142 if link == 'v2' else 76]:
        crc ^= value
        for _ in range(8):
            crc = (crc >> 1) ^ (0xa001 if crc & 1 else 0)
    offset = 142 if link == 'v2' else 14+len(payload)
    struct.pack_into('<H',packet,offset,crc)
    return bytes(packet)


def demo_packet(profile, seq, foot, wall_ms):
    phase = seq*.12 + (math.pi if foot == 'r' else 0)
    if profile == 'wt':
        values = [int(200*math.sin(phase)),int(150*math.cos(phase)),2048,
                  int(120*math.sin(phase)),int(80*math.cos(phase)),0,0,0,0]
        return b'\x55\x61'+struct.pack('<9h',*values)
    dt = datetime.fromtimestamp(wall_ms/1000, timezone.utc)
    packet = bytearray(50)
    packet[:3] = b'\x5a\x00\x09'
    clock = dt.hour*10000000+dt.minute*100000+dt.second*1000+dt.microsecond//1000
    struct.pack_into('<IIIh6h',packet,3,seq,clock,dt.year*10000+dt.month*100+dt.day,2600,0,0,2048,3,-2,1)
    packet[29] = 2
    packet[30] = 6
    struct.pack_into('<2h',packet,44,int(1500+1200*math.sin(phase)),int(1600+1000*math.cos(phase)))
    struct.pack_into('<H',packet,48,crc_ccitt(packet[:-2].ljust(138,b'\0')))
    return bytes(packet)
