# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 OctetMill

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI interface for sing-box
LUCI_DEPENDS:=+luci-base +luci-lib-jsonc +sing-box (>=1.12) +rpcd +uclient-fetch +ca-bundle +lua +libuci-lua +nftables-json +kmod-nft-tproxy
LUCI_PKGARCH:=all

PKG_NAME:=luci-app-prism
PKG_VERSION:=0.9.0
PKG_RELEASE:=1
PKG_MAINTAINER:=OctetMill
PKG_LICENSE:=GPL-3.0-only
PKG_LICENSE_FILES:=LICENSE
PKG_URL:=https://github.com/octetmill/prism

include $(TOPDIR)/feeds/luci/luci.mk

define Package/luci-app-prism/conffiles
/etc/config/prism
/etc/prism/extra.json
endef

define Package/luci-app-prism/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	grep -qsF "/etc/prism/nodes/" /etc/sysupgrade.conf || echo "/etc/prism/nodes/" >> /etc/sysupgrade.conf
	/etc/init.d/prism enable
	service rpcd reload
}
endef

define Package/luci-app-prism/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/prism stop
	/etc/init.d/prism disable
}
endef

# $(eval $(call BuildPackage,luci-app-prism)) is called by luci.mk
