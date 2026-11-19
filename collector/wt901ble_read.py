"""WT901BLE（BLE 5.0）数据读取。

透传特征 FFE4(notify)/FFE9(write)；帧 55 61 + 9×int16(acc, gyro, angle)，20 字节，无校验。
BLE 单包可能含多帧或半帧，靠 FrameSplitter 重新切分。
"""

import argparse
import asyncio
import csv
import statistics
import time

from bleak import BleakClient, BleakScanner

NOTIFY = "0000ffe4-0000-1000-8000-00805f9a34fb"
FRAME_LEN = 20
ACC_SCALE = 16.0 / 32768
GYRO_SCALE = 2000.0 / 32768
ANGLE_SCALE = 180.0 / 32768


def s16(buf, i):
    v = buf[i] | (buf[i + 1] << 8)
    return v - 0x10000 if v & 0x8000 else v


class FrameSplitter:
    def __init__(self):
        self.buf = bytearray()
        self.period = 0.02
        self.last_pkt = None

    def feed(self, data):
        self.buf += data
        out = []
        while True:
            i = self.buf.find(b"\x55")
            if i < 0:
                self.buf.clear()
                return out
            if len(self.buf) - i < FRAME_LEN:
                del self.buf[:i]
                return out
            if self.buf[i + 1] == 0x61:
                out.append(bytes(self.buf[i:i + FRAME_LEN]))
                del self.buf[:i + FRAME_LEN]
            else:
                del self.buf[:i + 1]

    def stamps(self, t_arrival, n):
        """一个 BLE 包内可能含多帧，按估计周期把各帧的时间戳摊开。"""
        if self.last_pkt is not None:
            gap = t_arrival - self.last_pkt
            if 0 < gap < 0.5:
                self.period = min(0.1, max(0.002, 0.8 * self.period + 0.2 * gap / n))
        self.last_pkt = t_arrival
        return [t_arrival - (n - 1 - k) * self.period for k in range(n)]


def decode(f):
    acc = [s16(f, 2 + 2 * k) * ACC_SCALE for k in range(3)]
    gyro = [s16(f, 8 + 2 * k) * GYRO_SCALE for k in range(3)]
    ang = [s16(f, 14 + 2 * k) * ANGLE_SCALE for k in range(3)]
    return acc, gyro, ang


async def pick_device(addr, prefix):
    if addr:
        return addr
    devs = await BleakScanner.discover(timeout=6.0, return_adv=True)
    cand = sorted(
        ((adv.rssi, a, d.name) for a, (d, adv) in devs.items()
         if (d.name or "").upper().startswith(prefix)),
        reverse=True,
    )
    if not cand:
        print(f"未发现名称以 {prefix} 开头的设备，确认传感器已上电")
        return None
    print("发现的设备：")
    for r, a, n in cand:
        print(f"  {a}  {n}  rssi={r}")
    print(f"选用信号最强：{cand[0][1]}")
    return cand[0][1]


async def connect(addr, tries=3):
    # WinRT 首次连接常因缓存未就绪报 DeviceNotFound，先扫一轮再重试
    await BleakScanner.discover(timeout=3.0)
    last = None
    for k in range(tries):
        try:
            cli = BleakClient(addr, timeout=25)
            await cli.connect()
            return cli
        except Exception as e:
            last = e
            print(f"连接失败 {k + 1}/{tries}：{e}")
            await asyncio.sleep(1.5)
    raise last


async def run(args):
    addr = await pick_device(args.addr, args.prefix)
    if not addr:
        return
    splitter = FrameSplitter()
    rows = []
    state = {"t0": 0.0, "last": 0.0}

    def on_data(_, data):
        ta = time.perf_counter() - state["t0"]
        frames = splitter.feed(data)
        if not frames:
            return
        for t, f in zip(splitter.stamps(ta, len(frames)), frames):
            rows.append((t, *decode(f)))

    cli = await connect(addr)
    state["t0"] = time.perf_counter()
    try:
        await cli.start_notify(NOTIFY, on_data)
        print(f"已连接 {addr}，Ctrl+C 停止\n")
        last_print = 0.0
        while True:
            await asyncio.sleep(0.1)
            now = time.perf_counter() - state["t0"]
            if rows and now - last_print >= 0.5:
                last_print = now
                _, acc, gyro, ang = rows[-1]
                print(
                    f"t={now:7.2f}s  "
                    f"acc=({acc[0]:+.2f},{acc[1]:+.2f},{acc[2]:+.2f})g  "
                    f"gyro=({gyro[0]:+7.1f},{gyro[1]:+7.1f},{gyro[2]:+7.1f})dps  "
                    f"angle=({ang[0]:+7.1f},{ang[1]:+7.1f},{ang[2]:+7.1f})deg  "
                    f"n={len(rows)}"
                )
            if args.secs and now >= args.secs:
                break
    except KeyboardInterrupt:
        pass
    finally:
        try:
            await cli.stop_notify(NOTIFY)
        except Exception:
            pass
        await cli.disconnect()

    if not rows:
        print("没有收到数据帧")
        return
    dur = rows[-1][0] - rows[0][0]
    print(f"\n共 {len(rows)} 帧 / {dur:.2f}s ≈ {len(rows) / dur:.1f} Hz")
    step = [rows[k + 1][0] - rows[k][0] for k in range(len(rows) - 1)]
    if step:
        print(f"帧间隔 中位 {statistics.median(step) * 1e3:.2f} ms  "
              f"最小 {min(step) * 1e3:.2f}  最大 {max(step) * 1e3:.2f}")
    names = ["ax", "ay", "az", "gx", "gy", "gz", "roll", "pitch", "yaw"]
    flat = [rows[k][1] + rows[k][2] + rows[k][3] for k in range(len(rows))]
    for i, nm in enumerate(names):
        col = [r[i] for r in flat]
        print(f"  {nm:>5}  均值 {statistics.mean(col):+9.3f}  标准差 {statistics.pstdev(col):7.3f}"
              f"  范围 [{min(col):+9.2f}, {max(col):+9.2f}]")

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as fp:
            w = csv.writer(fp)
            w.writerow(["t_s", "ax_g", "ay_g", "az_g",
                        "gx_dps", "gy_dps", "gz_dps",
                        "roll_deg", "pitch_deg", "yaw_deg"])
            for t, acc, gyro, ang in rows:
                w.writerow([f"{t:.4f}", *[f"{v:.4f}" for v in acc + gyro + ang]])
        print(f"已写入 {args.csv}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--addr", default="", help="蓝牙地址；留空则扫描并选信号最强的")
    ap.add_argument("--prefix", default="WT", help="扫描时的设备名前缀")
    ap.add_argument("--secs", type=float, default=0, help="采集时长，0 表示一直采")
    ap.add_argument("--csv", default="", help="输出 CSV 路径")
    asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    main()
