---
title: "把私有加速网关接入 iStoreOS：从需求到 OpenWrt fw4/nftables 实现"
published: 2026-07-03
description: "记录一次在 iStoreOS / OpenWrt 上接入私有加速网关的完整过程，包括静态路由、SNAT、fw4/nftables 规则顺序、验证与回滚。"
image: ""
tags: ["iStoreOS", "OpenWrt", "fw4", "nftables", "网络"]
category: "技术"
draft: false
lang: "zh-CN"
---

## 引言

有些“网络加速”工具并不会提供传统意义上的 HTTP、SOCKS5 或 Clash 节点，而是给出一组更底层的三层网络参数：一个私有加速 IP、一个私有网关，以及对应的出口链路。

单台设备使用时，通常只需要在设备上手动配置 IP、掩码、网关即可。但如果希望让局域网内的多台设备共享这条加速链路，并且只让部分目标 IP 走加速，就需要在路由器上完成策略路由和源地址转换。

本文记录一次在 iStoreOS / OpenWrt 上接入私有加速网关的完整过程。为避免暴露具体软件特征，文中的加速网段使用虚构的 RFC1918 私有地址，目标 IP 使用 RFC 5737 文档示例地址。实际使用时请替换为自己的参数。

## 需求与网络模型

实际需求是：局域网内的设备仍然默认走原有宽带出口，只让少数特定目标 IP 走私有加速网关。

本文统一使用以下虚构示例参数：

```text
路由器系统：iStoreOS / OpenWrt
LAN 设备：br-lan
LAN 网段：192.168.50.0/24
路由器 LAN 地址：192.168.50.1
示例客户端地址：192.168.50.23

虚构加速网段：10.88.7.0/24
虚构加速 IP：10.88.7.10/24
虚构加速网关：10.88.7.1
虚构加速掩码：255.255.255.0

需要走加速的目标 IP 示例：
  203.0.113.10/32
  203.0.113.20/32
```

其中 `10.88.7.0/24` 是本文自造的私有网段，用来模拟加速软件分配的私有链路；`203.0.113.0/24` 是 RFC 5737 定义的文档示例地址段，不是真实目标。实际使用时，把这些示例参数替换成自己的加速 IP、加速网关和目标 IP。如果你的局域网、VPN、容器网络或其他隧道已经使用 `10.88.7.0/24`，请换成不会冲突的私有网段。

目标流量模型如下：

```text
普通访问：
LAN 客户端 → iStoreOS → 普通 WAN / PPPoE 出口

指定目标访问：
LAN 客户端 → iStoreOS → SNAT 为 10.88.7.10 → 10.88.7.1 → 加速出口
```

这不是全局代理，也不是透明代理。它更接近“基于目标 IP 的策略路由 + 源地址转换”。

## 为什么不能只加静态路由

如果只在路由器上添加：

```text
203.0.113.10/32 via 10.88.7.1
203.0.113.20/32 via 10.88.7.1
```

那么路由器只知道这些目标应该发给加速网关，但局域网客户端原始源地址仍然是：

```text
192.168.50.23
```

而私有加速网关通常只接受分配给你的加速 IP，例如本文示例里的：

```text
10.88.7.10
```

因此，LAN 客户端流量必须在路由器出站时被 SNAT 成加速 IP：

```text
192.168.50.23 → 10.88.7.10
```

这就是本方案的核心。

## 实现思路

完整实现分为四步：

1. 在 `br-lan` 上增加加速 IP：`10.88.7.10/24`
2. 为指定目标 IP 添加静态路由，经由 `10.88.7.1`
3. 在 nftables / fw4 中添加 SNAT，把 LAN 源地址改成 `10.88.7.10`
4. 验证路由、邻居表、SNAT 计数器和实际访问结果

其中第 3 步是最容易踩坑的地方。本次最终确认：SNAT 规则应尽量靠前执行，最终放在：

```text
/usr/share/nftables.d/chain-pre/srcnat/05-accel-snat.nft
```

本案例中不建议放在：

```text
/usr/share/nftables.d/chain-post/srcnat/90-accel-snat.nft
```

后者虽然能在 `nft list chain inet fw4 srcnat` 中看到规则，但执行位置偏后，可能无法达到与临时 `nft insert rule` 相同的效果。

## 先定义示例变量

为了让后续命令更清晰，先定义统一变量。本文后面的命令都基于同一组变量。

```bash
LAN_IF="br-lan"
LAN_CIDR="192.168.50.0/24"

ACCEL_IP="10.88.7.10"
ACCEL_PREFIX="24"
ACCEL_NETMASK="255.255.255.0"
ACCEL_GW="10.88.7.1"

TARGETS="203.0.113.10 203.0.113.20"
```

实际部署时，只需要把这一段改成自己的真实参数，后面的命令逻辑保持不变。后文的验证和回滚命令也依赖这些变量；如果重新打开了 SSH 会话，需要先重新执行这一段变量定义。

## 前置验证：先用单台设备直连测试

在改路由器之前，建议先用一台手机、电脑或临时测试设备直连这条加速链路。测试设备手动配置加速 IP、子网掩码和加速网关后，直接访问真实目标服务。

这一步的目的不是配置路由器，而是确认加速链路本身可用：

```text
测试设备 IP：10.88.7.10
子网掩码：255.255.255.0
网关：10.88.7.1
```

如果单设备直配后仍然无法走加速，问题大概率不在 OpenWrt；应先检查加速软件、链路授权、网关可达性或目标是否匹配。

如果单设备直配正常，再继续下面的路由器接管配置。

## 第一步：确认加速网关二层可达

在做持久化配置前，先确认路由器能不能在二层上找到加速网关。

先临时让路由器持有加速 IP：

```bash
ip addr add "$ACCEL_IP/$ACCEL_PREFIX" dev "$LAN_IF" 2>/dev/null || true
```

然后清理邻居缓存并测试：

```bash
ip neigh flush dev "$LAN_IF"
ping -c 3 -W 1 -I "$ACCEL_IP" "$ACCEL_GW"
ip neigh show dev "$LAN_IF" | grep "$ACCEL_GW"
```

理想结果类似：

```text
10.88.7.1 lladdr xx:xx:xx:xx:xx:xx REACHABLE
```

这里重点看邻居表状态。`REACHABLE` 说明路由器能解析到网关 MAC，二层链路成立。

如果看到的是：

```text
FAILED
INCOMPLETE
```

则说明路由器到加速网关的二层链路不通。此时继续配置静态路由和 SNAT 也没有意义，应先检查加速软件所在设备、交换网络、桥接模式或 IP 是否被其他设备占用。

部分私有加速网关可能对 ICMP 有限速或特殊处理，所以不能仅凭 ping 延迟判断 TCP/UDP 加速效果。

## 第二步：配置 accel 接口

在 OpenWrt / iStoreOS 中，可以通过 UCI 增加一个静态接口。这里让 `br-lan` 额外持有加速 IP。

```bash
uci -q delete network.accel

uci set network.accel='interface'
uci set network.accel.proto='static'
uci set network.accel.device="$LAN_IF"
uci set network.accel.ipaddr="$ACCEL_IP"
uci set network.accel.netmask="$ACCEL_NETMASK"
uci set network.accel.gateway="$ACCEL_GW"
uci set network.accel.metric='500'
uci set network.accel.defaultroute='0'
uci set network.accel.peerdns='0'

uci commit network
/etc/init.d/network reload
```

这里有两个参数很关键：

```text
defaultroute='0'
peerdns='0'
```

原因是：本需求并不是让整个路由器默认出口都切到加速网关，而是只让指定目标 IP 走加速。普通流量仍应走原来的 WAN / PPPoE 出口。

如果你的加速 IP 不是 `/24`，需要同时修改：

```bash
ACCEL_PREFIX="24"
ACCEL_NETMASK="255.255.255.0"
```

例如 `/16` 对应 `255.255.0.0`，`/24` 对应 `255.255.255.0`。

配置后检查：

```bash
ip -4 addr show dev "$LAN_IF"
ip route | grep default
```

期望结果是：

```text
br-lan 上同时存在原 LAN 地址和加速 IP
默认路由仍然指向原来的 WAN / PPPoE 出口
```

## 第三步：添加目标 IP 静态路由

先清理旧的目标路由，避免重复。

```bash
for ip in $TARGETS; do
    while true; do
        section=$(uci show network | grep "\.target='$ip/32'" | cut -d. -f2 | cut -d= -f1 | head -n 1)
        [ -z "$section" ] && break
        echo "Deleting network.$section target=$ip/32"
        uci delete network.$section
    done
done

uci commit network
/etc/init.d/network reload
```

再添加新的静态路由：

```bash
for ip in $TARGETS; do
    uci add network route
    uci set network.@route[-1].interface='accel'
    uci set network.@route[-1].target="$ip/32"
    uci set network.@route[-1].gateway="$ACCEL_GW"
done

uci commit network
/etc/init.d/network reload
```

验证路由：

```bash
for ip in $TARGETS; do
    ip route get "$ip"
done
```

正确结果应类似：

```text
203.0.113.10 via 10.88.7.1 dev br-lan src 10.88.7.10
203.0.113.20 via 10.88.7.1 dev br-lan src 10.88.7.10
```

这说明路由器自己访问这些目标时，已经会从加速 IP 出去。

但这还不够。LAN 客户端访问时，源地址仍然是内网地址，还需要 SNAT。

## 第四步：配置 SNAT

OpenWrt 22.03 之后使用 fw4 和 nftables。自定义 nft 规则可以通过 `/usr/share/nftables.d/` 下的 include 目录加载。

本次踩坑点在这里：最初把 SNAT 规则放到了：

```text
/usr/share/nftables.d/chain-post/srcnat/90-accel-snat.nft
```

规则可以显示在 `nft list chain inet fw4 srcnat` 中，但实际没有达到预期效果。

后来用临时命令测试：

```bash
for ip in $TARGETS; do
    nft insert rule inet fw4 srcnat ip saddr "$LAN_CIDR" ip daddr "$ip" oifname "$LAN_IF" counter snat ip to "$ACCEL_IP"
done
```

临时规则可以正常加速。由此判断，问题不是路由器不能转发，也不是加速网关拒绝 NAT 流量，而是持久化规则的加载位置或执行顺序不对。

最终改为放到 `chain-pre/srcnat`：

```bash
mkdir -p /usr/share/nftables.d/chain-pre/srcnat

{
    for ip in $TARGETS; do
        echo "ip saddr $LAN_CIDR ip daddr $ip oifname \"$LAN_IF\" counter snat ip to $ACCEL_IP"
    done
} > /usr/share/nftables.d/chain-pre/srcnat/05-accel-snat.nft

/etc/init.d/firewall reload
```

如果之前创建过 `chain-post` 规则文件，建议移走，避免重复或干扰：

```bash
mkdir -p /root/accel-clean-backup

mv /usr/share/nftables.d/chain-post/srcnat/90-accel-snat.nft \
   /root/accel-clean-backup/90-accel-snat.nft.disabled.$(date +%Y%m%d-%H%M%S) 2>/dev/null

/etc/init.d/firewall reload
```

检查规则是否加载：

```bash
nft list chain inet fw4 srcnat | grep -E "$(echo $TARGETS | sed 's/ /|/g')|$ACCEL_IP"
```

应看到类似：

```text
ip saddr 192.168.50.0/24 ip daddr 203.0.113.10 oifname "br-lan" counter snat ip to 10.88.7.10
ip saddr 192.168.50.0/24 ip daddr 203.0.113.20 oifname "br-lan" counter snat ip to 10.88.7.10
```

## 完整一键配置命令

下面是一组可直接执行的完整配置模板。执行前请根据自己的环境修改变量。

```bash
# ===== 修改这里 =====
LAN_IF="br-lan"
LAN_CIDR="192.168.50.0/24"

ACCEL_IP="10.88.7.10"
ACCEL_PREFIX="24"
ACCEL_NETMASK="255.255.255.0"
ACCEL_GW="10.88.7.1"

TARGETS="203.0.113.10 203.0.113.20"
# ====================

# 1. 配置 accel 接口
uci -q delete network.accel

uci set network.accel='interface'
uci set network.accel.proto='static'
uci set network.accel.device="$LAN_IF"
uci set network.accel.ipaddr="$ACCEL_IP"
uci set network.accel.netmask="$ACCEL_NETMASK"
uci set network.accel.gateway="$ACCEL_GW"
uci set network.accel.metric='500'
uci set network.accel.defaultroute='0'
uci set network.accel.peerdns='0'

uci commit network
/etc/init.d/network reload

# 2. 清理旧目标路由
for ip in $TARGETS; do
    while true; do
        section=$(uci show network | grep "\.target='$ip/32'" | cut -d. -f2 | cut -d= -f1 | head -n 1)
        [ -z "$section" ] && break
        uci delete network.$section
    done
done

uci commit network
/etc/init.d/network reload

# 3. 添加目标路由
for ip in $TARGETS; do
    uci add network route
    uci set network.@route[-1].interface='accel'
    uci set network.@route[-1].target="$ip/32"
    uci set network.@route[-1].gateway="$ACCEL_GW"
done

uci commit network
/etc/init.d/network reload

# 4. 移除旧 chain-post 规则，使用 chain-pre 规则
mkdir -p /root/accel-clean-backup
mv /usr/share/nftables.d/chain-post/srcnat/90-accel-snat.nft \
   /root/accel-clean-backup/90-accel-snat.nft.disabled.$(date +%Y%m%d-%H%M%S) 2>/dev/null

mkdir -p /usr/share/nftables.d/chain-pre/srcnat
{
    for ip in $TARGETS; do
        echo "ip saddr $LAN_CIDR ip daddr $ip oifname \"$LAN_IF\" counter snat ip to $ACCEL_IP"
    done
} > /usr/share/nftables.d/chain-pre/srcnat/05-accel-snat.nft

/etc/init.d/firewall reload
```

## 验证配置是否生效

配置完成后，建议按以下顺序验证。如果已经重新打开 SSH 会话，请先重新执行前文的变量定义部分。

### 1. 检查地址

```bash
ip -4 addr show dev "$LAN_IF"
```

应看到原 LAN 地址和加速 IP。

### 2. 检查目标路由

```bash
for ip in $TARGETS; do
    ip route get "$ip"
done
```

应看到：

```text
via 10.88.7.1 dev br-lan src 10.88.7.10
```

### 3. 检查 SNAT 规则

```bash
nft -a list chain inet fw4 srcnat | grep -E "$(echo $TARGETS | sed 's/ /|/g')"
```

将 `TARGETS` 替换成真实目标 IP 后，从 LAN 客户端访问对应服务；如果 `counter packets` 增长，说明规则命中。

### 4. 抓包确认源地址

```bash
# 将 203.0.113.10 / 203.0.113.20 替换成你的真实目标 IP
tcpdump -ni "$LAN_IF" "(host 203.0.113.10 or host 203.0.113.20 or host $ACCEL_GW)"
```

正常情况下，访问目标 IP 时可以看到源地址已经变成：

```text
10.88.7.10
```

### 5. 确认默认路由没有被污染

```bash
ip route | grep default
ip route get 1.1.1.1
```

普通流量应继续走原 WAN / PPPoE 出口，而不是加速网关。

## 如何清理或回滚

如果后续不再让路由器占用加速 IP，需要先释放相关配置。以下命令同样依赖前文变量；如果已经重新打开 SSH 会话，请先重新执行变量定义部分，或手动把变量替换成真实值。

### 删除 accel 接口和相关路由

```bash
while true; do
    section=$(uci show network | grep "\.interface='accel'" | cut -d. -f2 | cut -d= -f1 | head -n 1)
    [ -z "$section" ] && break
    uci delete network.$section
done

uci -q delete network.accel
uci commit network
/etc/init.d/network reload
```

### 删除运行时残留地址

```bash
ip addr del "$ACCEL_IP/$ACCEL_PREFIX" dev "$LAN_IF" 2>/dev/null
ip neigh del "$ACCEL_GW" dev "$LAN_IF" 2>/dev/null
```

### 移走 SNAT 文件

```bash
mkdir -p /root/accel-clean-backup

mv /usr/share/nftables.d/chain-pre/srcnat/05-accel-snat.nft \
   /root/accel-clean-backup/05-accel-snat.nft.disabled.$(date +%Y%m%d-%H%M%S) 2>/dev/null

mv /usr/share/nftables.d/chain-post/srcnat/90-accel-snat.nft \
   /root/accel-clean-backup/90-accel-snat.nft.disabled.$(date +%Y%m%d-%H%M%S) 2>/dev/null

/etc/init.d/firewall reload
```

### 检查清理结果

```bash
ip -4 addr show dev "$LAN_IF"
ip route | grep -E "$(echo $TARGETS | sed 's/ /|/g')|$ACCEL_GW|$ACCEL_IP"
uci show network | grep -E "accel|$(echo $TARGETS | sed 's/ /|/g')|$ACCEL_GW|$ACCEL_IP"
nft list chain inet fw4 srcnat | grep -E "$(echo $TARGETS | sed 's/ /|/g')|$ACCEL_IP"
```

理想状态是：

```text
br-lan 只剩原 LAN 地址
没有 accel 接口
没有目标静态路由
没有相关 SNAT 规则
```

## 本次踩坑总结

这次问题最容易误判的地方是：

```text
ip route get 正确
nft list chain 也能看到规则
但实际没有加速
```

这说明“能看到规则”不等于“规则在正确的位置被优先命中”。

最终有效的判断链路是：

1. 单设备直配加速 IP 能用，说明加速网关本身可用。
2. 路由器邻居表为 `REACHABLE`，说明 br-lan 到加速网关二层可达。
3. 临时 `nft insert rule` 正常，说明路由器转发 + SNAT 这种模式可行。
4. 把规则从 `chain-post/srcnat` 改到 `chain-pre/srcnat` 后正常，说明关键差异是 fw4/nftables 的规则执行顺序。

所以本方案真正的关键不是“加一条 SNAT”这么简单，而是：

```text
在 OpenWrt fw4 中，把这条 SNAT 放到足够靠前的位置。
```

## 结语

对于这类只提供私有 IP 和私有网关的加速服务，路由器接管的本质是“目标路由 + 源地址转换”。

如果只是单台设备使用，手动配置加速 IP 和网关即可。如果希望局域网内多个设备共享，并且只让指定目标走加速，那么在 OpenWrt/iStoreOS 上实现是可行的，但需要特别注意 fw4/nftables 的规则顺序。

本次最终稳定配置可以概括为：

```text
br-lan 持有加速 IP
目标 IP 静态路由到加速网关
LAN 访问目标 IP 时 SNAT 为加速 IP
SNAT 文件放到 chain-pre/srcnat
```

这套方式不会污染普通默认路由，也不会让所有流量都走加速链路，适合只针对少数目标 IP 做定向加速的场景。
