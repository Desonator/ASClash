#!/bin/sh
# ================================================================
#  ASClash Auto-Installer for OpenWrt
#  Поддерживаемые версии: 21.x / 23.05.x / 24.10.x / 25.12.x
#  Архитектуры: arm64, armv7/armv6/armv5, amd64, 386,
#  mips/mipsel (soft/hardfloat), mips64/mips64le, riscv64, loong64
#  https://github.com/Desonator/ASClash
# ================================================================

ASCLASH_API="https://api.github.com/repos/Desonator/ASClash/releases/latest"
MIHOMO_BASE="https://github.com/MetaCubeX/mihomo/releases"
MIHOMO_API="https://api.github.com/repos/MetaCubeX/mihomo/releases/latest"
CLASH_BIN="/opt/clash/bin/clash"

# ASCLASH_VER и URL пакетов заполняются в fetch_asclash_release()
ASCLASH_VER=""
ASCLASH_APK_URL=""
ASCLASH_IPK_URL=""
PKG_UPDATED=0 # станет 1, если ensure_curl() уже обновил индекс

# ── цвета ───────────────────────────────────────────────────────
# printf '\033[Xm' корректно интерпретируется в любом POSIX sh
if [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ]; then
    R=$(printf '\033[0;31m') G=$(printf '\033[0;32m') Y=$(printf '\033[1;33m')
    C=$(printf '\033[0;36m') B=$(printf '\033[1m')    N=$(printf '\033[0m')
else
    R='' G='' Y='' C='' B='' N=''
fi
log()  { printf "%s[+]%s %s\n" "$G" "$N" "$*"; }
info() { printf "%s[i]%s %s\n" "$C" "$N" "$*"; }
warn() { printf "%s[!]%s %s\n" "$Y" "$N" "$*"; }
die()  { printf "%s[✗] %s%s\n" "$R" "$*" "$N" >&2; exit 1; }
sep()  { printf "%s%s%s\n"     "$C" "────────────────────────────────────────" "$N"; }

# ================================================================
#  0. Гарантируем наличие curl
#     Вызывается после detect_openwrt (нужен PKG_MGR),
#     но до любых сетевых запросов
# ================================================================
ensure_curl() {
    if command -v curl >/dev/null 2>&1; then
        info "curl: уже установлен ($(curl --version | head -1 | cut -d' ' -f1-2))"
        return 0
    fi

    warn "curl не найден — устанавливаю..."
    if [ "$PKG_MGR" = "apk" ]; then
        apk update  || die "apk update завершился с ошибкой"
        apk add curl || die "Не удалось установить curl"
    else
        opkg update  || die "opkg update завершился с ошибкой"
        opkg install curl || die "Не удалось установить curl"
    fi

    command -v curl >/dev/null 2>&1 || die "curl всё равно недоступен после установки"
    log "curl установлен"

    # Флаг: индекс пакетов уже обновлён — pkg_update() повторно не нужен
    PKG_UPDATED=1
}

# ================================================================
#  1. Версия OpenWrt и пакетный менеджер
# ================================================================
detect_openwrt() {
    [ -f /etc/openwrt_release ] || die "Не найден /etc/openwrt_release — это OpenWrt?"
    . /etc/openwrt_release

    OW_RELEASE="${DISTRIB_RELEASE:-unknown}"
    OW_MAJOR=$(echo "$OW_RELEASE" | cut -d. -f1)

    info "OpenWrt: ${B}${OW_RELEASE}${N}"

    # OpenWrt 25+ использует apk; 21-24 — opkg
    if [ "${OW_MAJOR:-0}" -ge 25 ] 2>/dev/null; then
        PKG_MGR="apk"
    else
        PKG_MGR="opkg"
    fi
    info "Пакетный менеджер: ${B}${PKG_MGR}${N}"

    # Для OpenWrt 21.x нужен iptables-mod-tproxy вместо kmod-nft-tproxy
    if [ "${OW_MAJOR:-0}" -le 21 ] 2>/dev/null; then
        TPROXY_PKG="iptables-mod-tproxy"
    else
        TPROXY_PKG="kmod-nft-tproxy"
    fi
    info "Пакет tproxy: ${B}${TPROXY_PKG}${N}"
}

# ================================================================
#  2. Определение архитектуры → имя файла ядра mihomo
# ================================================================
detect_arch() {
    ARCH_RAW=$(uname -m)

    # DISTRIB_ARCH из /etc/openwrt_release — самый надёжный источник на OpenWrt.
    # Уже было прочитано в detect_openwrt(), но detect_arch может вызываться
    # отдельно, поэтому подгружаем снова (идемпотентно).
    . /etc/openwrt_release
    TARGET="${DISTRIB_TARGET:-}"
    ARCH_PKG="${DISTRIB_ARCH:-}"

    info "CPU (uname -m): ${B}${ARCH_RAW}${N}"
    info "OpenWrt target: ${B}${TARGET}${N}"
    info "DISTRIB_ARCH:   ${B}${ARCH_PKG}${N}"

    MIHOMO_ARCH=""

    # --- Основной путь: маппинг по DISTRIB_ARCH ---------------------------
    # Зеркалирует логику detectSystemArchitecture() в luci-app settings.js,
    # чтобы инсталлер и веб-интерфейс выбирали одно и то же ядро mihomo.
    case "$ARCH_PKG" in
        aarch64_*)      MIHOMO_ARCH="arm64" ;;
        x86_64)         MIHOMO_ARCH="amd64-compatible" ;;
        i386_*)         MIHOMO_ARCH="386" ;;
        riscv64_*)      MIHOMO_ARCH="riscv64" ;;
        loongarch64_*)  MIHOMO_ARCH="loong64" ;;
        arm_*)
            # ARMv5/v6/v7 различаются по ядру/float/SIMD-признакам в строке арки.
            # 32-битные Cortex-A (a5/a7/a8/a9/a15/a17) — это ARMv7-A, поэтому
            # сразу armv7 (иначе cortex-a9_vfpv3 ошибочно ушёл бы в armv6).
            case "$ARCH_PKG" in
                *cortex-a*)      MIHOMO_ARCH="armv7" ;;
                *_neon-vfp*)     MIHOMO_ARCH="armv7" ;;
                *_neon*|*_vfp*)  MIHOMO_ARCH="armv6" ;;
                *)               MIHOMO_ARCH="armv5" ;;
            esac
            ;;
        mips64el_*)     MIHOMO_ARCH="mips64le" ;;
        mips64_*)       MIHOMO_ARCH="mips64" ;;
        mipsel_*)
            case "$ARCH_PKG" in
                *hardfloat*) MIHOMO_ARCH="mipsle-hardfloat" ;;
                *)           MIHOMO_ARCH="mipsle-softfloat" ;;
            esac
            ;;
        mips_*)
            case "$ARCH_PKG" in
                *hardfloat*) MIHOMO_ARCH="mips-hardfloat" ;;
                *)           MIHOMO_ARCH="mips-softfloat" ;;
            esac
            ;;
    esac

    # --- Fallback: если DISTRIB_ARCH пуст или незнаком — по uname -m -------
    if [ -z "$MIHOMO_ARCH" ]; then
        [ -n "$ARCH_PKG" ] && warn "DISTRIB_ARCH '${ARCH_PKG}' не распознан — пробую uname -m"
        case "$ARCH_RAW" in
            aarch64)         MIHOMO_ARCH="arm64" ;;
            armv7l)          MIHOMO_ARCH="armv7" ;;
            armv6l)          MIHOMO_ARCH="armv6" ;;
            armv5l|armv5tel) MIHOMO_ARCH="armv5" ;;
            x86_64)          MIHOMO_ARCH="amd64-compatible" ;;
            i686|i386)       MIHOMO_ARCH="386" ;;
            riscv64)         MIHOMO_ARCH="riscv64" ;;
            loongarch64)     MIHOMO_ARCH="loong64" ;;
            mips64el)        MIHOMO_ARCH="mips64le" ;;
            mips64)          MIHOMO_ARCH="mips64" ;;
            # uname -m не различает soft/hardfloat для MIPS — берём softfloat
            # (24kc и большинство OpenWrt MIPS-таргетов именно softfloat).
            mipsel)          MIHOMO_ARCH="mipsle-softfloat" ;;
            mips)            MIHOMO_ARCH="mips-softfloat" ;;
            *)
                warn "Неизвестная архитектура: uname='${ARCH_RAW}' DISTRIB_ARCH='${ARCH_PKG}'"
                warn "Посмотри доступные ядра: ${MIHOMO_BASE}/latest"
                MIHOMO_ARCH=""
                ;;
        esac
    fi

    if [ -n "$MIHOMO_ARCH" ]; then
        info "Ядро mihomo: ${B}mihomo-linux-${MIHOMO_ARCH}${N}"
    fi
}

# ================================================================
#  3. Обновление индекса пакетов
# ================================================================
pkg_update() {
    if [ "$PKG_UPDATED" = "1" ]; then
        info "Индекс пакетов уже обновлён — пропускаю"
        return 0
    fi
    log "Обновление списка пакетов..."
    if [ "$PKG_MGR" = "apk" ]; then
        apk update || die "apk update завершился с ошибкой"
    else
        opkg update || die "opkg update завершился с ошибкой"
    fi
    PKG_UPDATED=1
}

# ================================================================
#  4. Установка зависимостей
# ================================================================
install_deps() {
    log "Установка зависимостей: ${TPROXY_PKG} kmod-tun coreutils-base64"
    if [ "$PKG_MGR" = "apk" ]; then
        apk add "$TPROXY_PKG" kmod-tun coreutils-base64 \
            || die "Ошибка установки зависимостей"
    else
        opkg install "$TPROXY_PKG" kmod-tun coreutils-base64 \
            || die "Ошибка установки зависимостей"
    fi
}

# ================================================================
#  5а. Получение последнего релиза ASClash через GitHub API
# ================================================================
fetch_asclash_release() {
    log "Определяю последнюю версию ASClash..."

    # GitHub API возвращает JSON; парсим grep+sed — без jq (его нет в OpenWrt по умолчанию)
    RELEASE_JSON=$(curl -s -L "$ASCLASH_API") \
        || die "Не удалось получить данные релиза ASClash"

    [ -z "$RELEASE_JSON" ] && die "GitHub API вернул пустой ответ"

    # Тег вида "v4.5.1"
    ASCLASH_VER=$(printf '%s' "$RELEASE_JSON" \
        | grep '"tag_name"' | head -1 \
        | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\([^"]*\)".*/\1/')

    [ -z "$ASCLASH_VER" ] && die "Не удалось распарсить tag_name из ответа GitHub API"
    info "Последняя версия ASClash: ${B}v${ASCLASH_VER}${N}"

    # Из списка assets берём URL для .apk и .ipk
    # browser_download_url идут построчно — берём нужные по расширению
    ASCLASH_APK_URL=$(printf '%s' "$RELEASE_JSON" \
        | grep '"browser_download_url"' \
        | grep '\.apk"' | head -1 \
        | sed 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

    ASCLASH_IPK_URL=$(printf '%s' "$RELEASE_JSON" \
        | grep '"browser_download_url"' \
        | grep '\.ipk"' | head -1 \
        | sed 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

    if [ "$PKG_MGR" = "apk" ]; then
        [ -z "$ASCLASH_APK_URL" ] && die "Не найден .apk в assets релиза ASClash"
        info "Пакет: ${B}${ASCLASH_APK_URL##*/}${N}"
    else
        [ -z "$ASCLASH_IPK_URL" ] && die "Не найден .ipk в assets релиза ASClash"
        info "Пакет: ${B}${ASCLASH_IPK_URL##*/}${N}"
    fi
}

# ================================================================
#  5б. Установка пакета luci-app-asclash
# ================================================================
remove_legacy_package() {
    local legacy_installed=0
    if [ "$PKG_MGR" = "apk" ]; then
        apk info -e luci-app-ssclash >/dev/null 2>&1 && legacy_installed=1
    else
        opkg list-installed 2>/dev/null | grep -q '^luci-app-ssclash[[:space:]]' && legacy_installed=1
    fi

    [ "$legacy_installed" = "1" ] || return 0

    warn "Обнаружен старый пакет luci-app-ssclash; переношу установку на luci-app-asclash."
    warn "Конфигурация в /opt/clash/config.yaml и пользовательские данные сохраняются."
    if [ -x /etc/init.d/clash ]; then
        /etc/init.d/clash stop || warn "Не удалось штатно остановить старую службу; продолжаю миграцию."
    fi

    if [ "$PKG_MGR" = "apk" ]; then
        apk del luci-app-ssclash || die "Не удалось удалить старый пакет luci-app-ssclash"
    else
        opkg remove luci-app-ssclash || die "Не удалось удалить старый пакет luci-app-ssclash"
    fi
}

install_asclash() {
    log "Загрузка ASClash v${ASCLASH_VER}..."

    if [ "$PKG_MGR" = "apk" ]; then
        PKG_FILE="/tmp/luci-app-asclash.apk"
        curl -fL --retry 2 --connect-timeout 15 --max-time 300 \
            "$ASCLASH_APK_URL" -o "$PKG_FILE" || die "Ошибка загрузки .apk"
        log "Установка пакета..."
        apk add --allow-untrusted "$PKG_FILE" || die "Ошибка установки .apk"
        rm -f "$PKG_FILE"
    else
        PKG_FILE="/tmp/luci-app-asclash.ipk"
        curl -fL --retry 2 --connect-timeout 15 --max-time 300 \
            "$ASCLASH_IPK_URL" -o "$PKG_FILE" || die "Ошибка загрузки .ipk"
        log "Установка пакета..."
        (cd /tmp && opkg install luci-app-asclash.ipk) || die "Ошибка установки .ipk"
        rm -f "$PKG_FILE"
    fi
}

# ================================================================
#  6. Загрузка и установка ядра mihomo
# ================================================================
install_mihomo() {
    if [ -z "$MIHOMO_ARCH" ]; then
        warn "Архитектура не определена автоматически."
        warn "Вручную скачай нужное ядро: ${MIHOMO_BASE}/latest"
        return 0
    fi

    # Версию берём через GitHub API
    log "Определяю последнюю версию mihomo..."
    MIHOMO_JSON=$(curl -s -L "$MIHOMO_API") \
        || die "Не удалось получить данные релиза mihomo. Проверь интернет-соединение."
    [ -z "$MIHOMO_JSON" ] && die "GitHub API вернул пустой ответ (mihomo)"

    # tag_name вида "v1.18.0" — используется и в URL, и в имени файла ассета
    MIHOMO_VER=$(printf '%s' "$MIHOMO_JSON" \
        | grep '"tag_name"' | head -1 \
        | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

    [ -z "$MIHOMO_VER" ] && die "Не удалось распарсить версию mihomo из ответа GitHub API"
    info "Последняя версия mihomo: ${B}${MIHOMO_VER}${N}"

    MIHOMO_URL="${MIHOMO_BASE}/download/${MIHOMO_VER}/mihomo-linux-${MIHOMO_ARCH}-${MIHOMO_VER}.gz"
    info "URL: ${MIHOMO_URL}"

    log "Загрузка ядра mihomo..."
    curl -fL --retry 2 --connect-timeout 15 --max-time 300 \
        "$MIHOMO_URL" -o /tmp/clash.gz || die "Ошибка загрузки ядра mihomo"

    log "Распаковка в ${CLASH_BIN}..."
    mkdir -p "$(dirname "$CLASH_BIN")"
    gunzip -c /tmp/clash.gz > "$CLASH_BIN" || die "Ошибка распаковки"
    chmod +x "$CLASH_BIN"
    rm -f /tmp/clash.gz

    if [ -f "/opt/clash/bin/meta-backup" ]; then
        log "Удаляю резервную копию ядра mihomo..."
        rm -f /opt/clash/bin/meta-backup
    fi

    log "Ядро установлено: $("$CLASH_BIN" -v 2>/dev/null || echo 'версия недоступна до запуска сервиса')"
}

# ================================================================
#  MAIN
# ================================================================
sep
printf "  ${B}ASClash Auto-Installer${N}\n"
sep

detect_openwrt
ensure_curl      # нужен для всех последующих сетевых запросов
detect_arch
fetch_asclash_release
sep

pkg_update
sep

# Запоминаем, был ли сервис включён до установки/обновления пакета
CLASH_WAS_ENABLED=0
if [ -x /etc/init.d/clash ] && /etc/init.d/clash enabled 2>/dev/null; then
    CLASH_WAS_ENABLED=1
    info "Сервис clash был включён — состояние будет восстановлено после обновления"
fi

remove_legacy_package
install_deps
sep
install_asclash

# Если сервис был включён до обновления — восстанавливаем enabled-состояние,
# которое post-install скрипт пакета сбросил в disabled
if [ "$CLASH_WAS_ENABLED" = "1" ] && [ -x /etc/init.d/clash ]; then
    log "Восстанавливаю автозапуск сервиса clash..."
    /etc/init.d/clash enable
fi
sep

# После post-upgrade хука clash мог автоматически стартовать и перехватить трафик
if [ -x /etc/init.d/clash ] && pidof clash >/dev/null 2>&1; then
    warn "Сервис clash запущен — останавливаю перед загрузкой ядра mihomo..."
    /etc/init.d/clash stop
fi

install_mihomo
sep

log "${G}Установка завершена!${N}"
echo ""
info "Следующие шаги:"
echo "  1. Открой LuCI → Services → ASClash"
echo "  2. Вставь свою конфигурацию Clash/Mihomo в редактор"
printf "  3. Нажми %sSave & Apply%s\n" "$B" "$N"
printf "  4. Перезапусти сервис: %s/etc/init.d/clash restart%s\n" "$B" "$N"
echo ""
warn "Если ядро mihomo не определилось автоматически:"
warn "  → ${MIHOMO_BASE}/latest"
sep
