# Copyright 2024-2026 ZeroChaos (https://github.com/zerolabnet/SSClash)
# ASClash fork modifications copyright 2026 Desonator (https://github.com/Desonator/ASClash)
# This is free software, licensed under the GNU General Public License v2.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-asclash
PKG_VERSION:=4.8.5.1
PKG_RELEASE:=1
PKG_MAINTAINER:=Desonator <https://github.com/Desonator>

LUCI_TITLE:=ASClash LuCI Support
LUCI_DEPENDS:=+luci-base +coreutils-base64 +firewall4 +kmod-nft-tproxy +kmod-tun +curl
LUCI_PKGARCH:=all

PKG_BUILD_DEPENDS:=luci-base/host

include $(INCLUDE_DIR)/package.mk

define Package/$(PKG_NAME)
	SECTION:=luci
	CATEGORY:=LuCI
	SUBMENU:=3. Applications
	TITLE:=$(LUCI_TITLE)
	DEPENDS:=$(LUCI_DEPENDS)
	PKGARCH:=$(LUCI_PKGARCH)
	CONFLICTS:=luci-app-ssclash
endef

define Package/$(PKG_NAME)/description
	LuCI interface for ASClash (Advanced Simple Clash), an OpenWrt Clash manager.
endef

define Build/Prepare
	# No preparation steps required
endef

define Build/Compile
	@mkdir -p $(PKG_BUILD_DIR)/po/ru
	@if [ -f "./rootfs/po/ru/asclash.po" ]; then \
		$(STAGING_DIR_HOSTPKG)/bin/po2lmo \
			"./rootfs/po/ru/asclash.po" \
			"$(PKG_BUILD_DIR)/po/ru/asclash.lmo"; \
	fi
	@mkdir -p $(PKG_BUILD_DIR)/po/zh-cn
	@if [ -f "./rootfs/po/zh-cn/asclash.po" ]; then \
		$(STAGING_DIR_HOSTPKG)/bin/po2lmo \
			"./rootfs/po/zh-cn/asclash.po" \
			"$(PKG_BUILD_DIR)/po/zh-cn/asclash.lmo"; \
	fi
endef

define Package/$(PKG_NAME)/conffiles
/opt/clash/config.yaml
endef

define Package/$(PKG_NAME)/install
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./rootfs/etc/init.d/clash $(1)/etc/init.d/

	$(INSTALL_DIR) $(1)/etc/hotplug.d/iface
	$(INSTALL_BIN) ./rootfs/etc/hotplug.d/iface/40-clash $(1)/etc/hotplug.d/iface/
	$(INSTALL_DIR) $(1)/etc/hotplug.d/net
	$(INSTALL_BIN) ./rootfs/etc/hotplug.d/net/99-clash-tun $(1)/etc/hotplug.d/net/

	$(INSTALL_DIR) $(1)/opt/clash/bin
	$(INSTALL_BIN) ./rootfs/opt/clash/bin/clash-rules $(1)/opt/clash/bin/
	$(INSTALL_BIN) ./rootfs/opt/clash/bin/asclash-api $(1)/opt/clash/bin/
	$(INSTALL_BIN) ./rootfs/opt/clash/bin/asclash-reload $(1)/opt/clash/bin/
	$(INSTALL_BIN) ./rootfs/opt/clash/bin/asclash-update $(1)/opt/clash/bin/

	$(INSTALL_DIR) $(1)/opt/clash
	$(INSTALL_DATA) ./rootfs/opt/clash/config.yaml $(1)/opt/clash/

	$(INSTALL_DIR) $(1)/opt/clash/ui
	$(CP) ./rootfs/opt/clash/ui/* $(1)/opt/clash/ui/

	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./rootfs/usr/share/luci/menu.d/luci-app-asclash.json $(1)/usr/share/luci/menu.d/

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./rootfs/usr/share/rpcd/acl.d/luci-app-asclash.json $(1)/usr/share/rpcd/acl.d/

	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/asclash
	$(CP) ./rootfs/www/luci-static/resources/view/asclash/* $(1)/www/luci-static/resources/view/asclash/

	$(INSTALL_DIR) $(1)/opt/clash/lst

ifdef CONFIG_USE_APK
	$(INSTALL_DIR) $(1)/etc/apk/protected_paths.d
	$(INSTALL_DATA) ./rootfs/etc/apk/protected_paths.d/asclash.list $(1)/etc/apk/protected_paths.d/
endif

	@if [ -f "$(PKG_BUILD_DIR)/po/ru/asclash.lmo" ]; then \
		$(INSTALL_DIR) $(1)/usr/lib/lua/luci/i18n; \
		$(INSTALL_DATA) "$(PKG_BUILD_DIR)/po/ru/asclash.lmo" \
			"$(1)/usr/lib/lua/luci/i18n/asclash.ru.lmo"; \
	fi
	@if [ -f "$(PKG_BUILD_DIR)/po/zh-cn/asclash.lmo" ]; then \
		$(INSTALL_DIR) $(1)/usr/lib/lua/luci/i18n; \
		$(INSTALL_DATA) "$(PKG_BUILD_DIR)/po/zh-cn/asclash.lmo" \
			"$(1)/usr/lib/lua/luci/i18n/asclash.zh-cn.lmo"; \
	fi
endef

define Package/$(PKG_NAME)/preinst
#!/bin/sh
mkdir -p /opt/clash 2>/dev/null || true
[ -f /opt/clash/config.yaml ] && cp -p /opt/clash/config.yaml /opt/clash/.config.yaml.upgrade.bak
exit 0
endef

define Package/$(PKG_NAME)/postinst
#!/bin/sh
if [ -f /opt/clash/.config.yaml.upgrade.bak ]; then
	mv /opt/clash/.config.yaml.upgrade.bak /opt/clash/config.yaml
	FIRST_INSTALL=0
else
	FIRST_INSTALL=1
fi
[ -n "$$IPKG_INSTROOT" ] || {
	/etc/init.d/rpcd reload
	rm -f /tmp/luci-*

	# On first install the default config.yaml is just a usable example
	# (no real proxies configured). Prevent auto-start on next boot so the
	# user can edit /opt/clash/config.yaml first. "Start Service" in LuCI
	# re-enables it via `/etc/init.d/clash enable`.
	if [ "$$FIRST_INSTALL" = "1" ]; then
		/etc/init.d/clash disable 2>/dev/null || true
	fi

	# Ensure periodic clash-rules update cron job exists
	CRON_FILE="/etc/crontabs/root"
	CRON_LINE="*/30 * * * * /opt/clash/bin/clash-rules update >/dev/null 2>&1"

	[ -f "$$CRON_FILE" ] || touch "$$CRON_FILE"
	if ! grep -Fq "/opt/clash/bin/clash-rules update" "$$CRON_FILE" 2>/dev/null; then
		echo "$$CRON_LINE" >> "$$CRON_FILE"
		/etc/init.d/cron restart >/dev/null 2>&1 || true
	fi
}
exit 0
endef

define Package/$(PKG_NAME)/postrm
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] || {
	# Clean up cron job for clash-rules update, if present
	CRON_FILE="/etc/crontabs/root"
	if [ -f "$$CRON_FILE" ]; then
		sed -i '\|/opt/clash/bin/clash-rules update|d' "$$CRON_FILE" 2>/dev/null || true
		/etc/init.d/cron restart >/dev/null 2>&1 || true
	fi

	rm -rf /opt/clash/ui
	rm -f /opt/clash/ruleset
	rm -f /opt/clash/.dns_backup
	rm -rf /tmp/clash
	rm -rf /www/luci-static/resources/view/asclash /www/luci-static/resources/view/ssclash
	rm -f /usr/lib/lua/luci/i18n/asclash.*.lmo /usr/lib/lua/luci/i18n/ssclash.*.lmo
	rm -f /opt/clash/.config.yaml.upgrade.bak
	rm -f /etc/hotplug.d/iface/40-clash
	rm -f /etc/hotplug.d/net/99-clash-tun
	rm -f /etc/apk/protected_paths.d/asclash.list /etc/apk/protected_paths.d/ssclash.list
}
endef

$(eval $(call BuildPackage,$(PKG_NAME)))
